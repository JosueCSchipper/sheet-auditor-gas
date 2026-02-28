// =========================================================================================
// GOOGLE SHEETS AUDITOR - Desarrollado por Josue Cavalheiro Schipper
// Propósito: Auditoría de linaje de datos, detección de errores y mapeo de dependencias.
// =========================================================================================

// Definición centralizada de nombres de hojas para reutilización dinámica
const HOJAS = {
  ANALISIS:   'Sheet-Auditor', // Panel de control y configuración del usuario
  DETALLES:   'Details',       // Registro masivo de hallazgos y fórmulas
  INVENTARIO: 'Inventory',     // Control de estados, profundidad e IDs únicos
  LOGS:       'Logs'            // Bitácora de ejecución técnica en tiempo real
};

const CONFIG = {
  SHEETS: HOJAS,

  CELDA: {
    ID_INICIAL:     'F2'       // Celda que contiene el ID raíz para empezar la auditoría
  },

  COLUMNAS: {
    ESTADO:          1,         // [A] Estado del archivo (PENDING, PROCESSING, etc.)
    PROFUNDIDAD:     2,         // [B] Nivel jerárquico en el árbol de dependencias
    NOMBRE:          3,         // [C] Nombre extraído del archivo auditado
    PROPIETARIO:     4,         // [D] Correo electrónico del dueño del archivo
    ID:              5,         // [E] ID único de Google Drive para el Sheet
    ID_PADRE:        6,         // [F] ID del archivo desde donde se descubrió el link
    CELDA_ORIGEN:    7,         // [G] Ubicación (Hoja!Celda) del link encontrado
    FECHA:           8,         // [H] Timestamp de la última modificación detectada
    PUNTERO:         9          // [I] Fila técnica para el sistema de Rollback
  },

  LIMITES: {
    TIEMPO_MS:      330000,    // 5.5 min para evitar el cierre forzado de Google
    LOTE_ESCRITURA: 50         // Cantidad de registros por escritura para performance
  },

  ESTADOS: {
    PENDIENTE:      '⏳ PENDING',    // Archivo en cola, esperando análisis
    PROCESANDO:     '⚙️ PROCESSING', // Analizando fórmulas actualmente
    COMPLETADO:     '✅ COMPLETED',  // Auditoría finalizada correctamente
    ERROR:          '🚫 ERROR'       // Falla técnica o falta de permisos
  },

  MAPA_ERRORES: {
    '#REF!':        'HIGH',    // Referencia de rango inválida
    '#NAME?':       'HIGH',    // Función o rango nombrado inexistente
    '#VALUE!':      'MEDIUM',  // Error de tipo de dato en la fórmula
    '#DIV/0!':      'MEDIUM',  // Intento de división por cero
    'LOADING':      'MEDIUM',  // Datos externos no cargados a tiempo
    '#N/A':         'LOW'      // Valor no disponible en la búsqueda
  },

  PATRONES: {
    ID_GSHEET:      /1[a-zA-Z0-9_-]{43}/g,      // Regex para extraer IDs de Sheets
    IMPORT_RANGE:   /IMPORTRANGE\(([^,]+),/gi   // Regex para capturar funciones de enlace
  },

  // Plan de limpieza dinámico para resetear el entorno de trabajo
  PLAN_LIMPIEZA: [
    { hoja: HOJAS.DETALLES,   limite: 100, rango: 'A2:I' }, // 1. Limpiamos el peso (Hallazgos)
    { hoja: HOJAS.INVENTARIO, limite: 30,  rango: 'A2:I' }, // 2. Limpiamos el origen de los datos
    { hoja: HOJAS.LOGS,       limite: 100, rango: 'A2:B' }, // 3. Limpiamos la bitácora técnica
    { hoja: HOJAS.ANALISIS,   limite: 30,  rango: 'A20:I'} // 4. ÚLTIMO: Limpiamos y podámos la interfaz
  ]
};

/**
 * GRUPO 1: ORQUESTACIÓN Y CONTROL DE FLUJO
 * Funciones que gestionan el ciclo de vida de la auditoría y la cola de trabajo.
 */

// Inicia el proceso de auditoría y gestiona la reanudación automática.
function runFullAudit() {
  const inicioReloj = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaInv = ss.getSheetByName(CONFIG.SHEETS.INVENTARIO);
  const hojaDet = ss.getSheetByName(CONFIG.SHEETS.DETALLES);
  const hojaLog = setupLogSheet();

  log(hojaLog, "🚀 INICIO: Arrancando motor de orquestación recursiva.");

  let { colaEjecucion, rastreadorFilas, registroProcesados } = initializeWorkload(hojaInv);

  if (colaEjecucion.length === 0) {
    const idRaiz = ss.getSheetByName(CONFIG.SHEETS.ANALISIS).getRange(CONFIG.CELDA.ID_INICIAL).getValue();
    if (!idRaiz) return log(hojaLog, `🚫 ERROR CRÍTICO: Celda ${CONFIG.CELDA.ID_INICIAL} vacía en ${CONFIG.SHEETS.ANALISIS}. Auditoría abortada.`);

    hojaInv.appendRow([CONFIG.ESTADOS.PENDIENTE, 0, "Archivo Inicial", "N/A", idRaiz, "ROOT", "MANUAL", "", ""]);    
    const fila = hojaInv.getLastRow();
    colaEjecucion.push({ id: idRaiz, profundidad: 0, indiceFila: fila });
    rastreadorFilas[idRaiz] = fila;
  }

  const registroDescubiertos = new Set(Object.keys(rastreadorFilas));

  while (colaEjecucion.length > 0) {
    if (Date.now() - inicioReloj > CONFIG.LIMITES.TIEMPO_MS) {
      log(hojaLog, "⏳ TIMEOUT: Se alcanzaron los 5.5 min. Estado persistido para reanudación.");
      break;
    }

    const tareaActual = colaEjecucion.shift();
    
    // LOG EXTRA 1: Salto de archivo ya auditado
    if (registroProcesados.has(tareaActual.id)) {
      log(hojaLog, `⏭️ SKIPPED: El ID ${tareaActual.id} ya fue auditado en esta sesión.`);
      continue;
    }

    const punteroExistente = hojaInv.getRange(tareaActual.indiceFila, CONFIG.COLUMNAS.PUNTERO).getValue();
    if (punteroExistente && !isNaN(punteroExistente)) {
      log(hojaLog, `↩️ ROLLBACK: Detectada sesión inconclusa. Limpiando fila ${punteroExistente} de Details.`);
      rollbackPartialData(hojaDet, punteroExistente, hojaLog);
    }

    const filaInicioDetalles = hojaDet.getLastRow() + 1;
    hojaInv.getRange(tareaActual.indiceFila, CONFIG.COLUMNAS.ESTADO).setValue(CONFIG.ESTADOS.PROCESANDO);
    hojaInv.getRange(tareaActual.indiceFila, CONFIG.COLUMNAS.PUNTERO).setValue(filaInicioDetalles);
    
    log(hojaLog, `📂 PROCESANDO: [ID: ${tareaActual.id}] - Iniciando escaneo de fórmulas.`);
    const resultados = performFileAudit(tareaActual.id, hojaLog); 
    registroProcesados.add(tareaActual.id);

    if (resultados) {
      if (resultados.hallazgos.length > 0) commitBatch(hojaDet, resultados.hallazgos);
      
      hojaInv.getRange(tareaActual.indiceFila, 1, 1, 4).setValues([[
        CONFIG.ESTADOS.COMPLETADO, tareaActual.profundidad, resultados.nombre, resultados.propietario
      ]]);
      hojaInv.getRange(tareaActual.indiceFila, CONFIG.COLUMNAS.FECHA).setValue(resultados.actualizado);

      let nuevosHijos = 0;
      Object.keys(resultados.hijos).forEach(idHijo => {
        if (!registroDescubiertos.has(idHijo)) {
          const nuevaProf = tareaActual.profundidad + 1;
          hojaInv.appendRow([CONFIG.ESTADOS.PENDIENTE, nuevaProf, "Pendiente...", "N/A", idHijo,
          tareaActual.id, resultados.hijos[idHijo], "", ""]);
          const nuevaFila = hojaInv.getLastRow();
          rastreadorFilas[idHijo] = nuevaFila;
          registroDescubiertos.add(idHijo);
          colaEjecucion.push({ id: idHijo, profundidad: nuevaProf, indiceFila: nuevaFila });
          nuevosHijos++;
        }
      });
      if (nuevosHijos > 0) log(hojaLog, `🔗 LINAJE: Detectados ${nuevosHijos} nuevos IDs únicos vía IMPORTRANGE/Regex.`);
    } else {
      hojaInv.getRange(tareaActual.indiceFila, CONFIG.COLUMNAS.ESTADO).setValue(CONFIG.ESTADOS.ERROR);
      hojaInv.getRange(tareaActual.indiceFila, CONFIG.COLUMNAS.NOMBRE).setValue("🚫 SIN ACCESO");
    }
  }
  log(hojaLog, `🏁 CICLO COMPLETADO: Auditoría pausada. Quedan ${colaEjecucion.length} archivos en cola.`);
}

// Escanea el inventario para reconstruir la cola de trabajo pendiente.
function initializeWorkload(hoja) {
  const datos = hoja.getDataRange().getValues();
  const colaEjecucion = [], rastreadorFilas = {}, registroProcesados = new Set();
  
  datos.forEach((fila, indice) => {
    if (indice === 0) return;
    const numFila = indice + 1, estado = fila[0], id = fila[4];
    rastreadorFilas[id] = numFila;
    
    if ([CONFIG.ESTADOS.COMPLETADO, CONFIG.ESTADOS.ERROR].includes(estado)) {
      registroProcesados.add(id);
    } else {
      colaEjecucion.push({ id: id, profundidad: fila[1], indiceFila: numFila });
    }
  });
  return { colaEjecucion, rastreadorFilas, registroProcesados };
}

// Borra el contenido de las hojas y poda las filas excedentes.
function cleanReset() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaLog = ss.getSheetByName(CONFIG.SHEETS.LOGS);
  CONFIG.PLAN_LIMPIEZA.forEach(plan => {
    const hoja = ss.getSheetByName(plan.hoja);
    if (!hoja) return;
    hoja.getRange(plan.rango).clearContent();
    const maxFilasActual = hoja.getMaxRows();
    if (maxFilasActual > plan.limite) {
      hoja.deleteRows(plan.limite + 1, maxFilasActual - plan.limite);
    }
  });
  log(hojaLog, "🧹 CLEANUP: Ecosistema reseteado. Tablas purgadas y punteros reiniciados.");
}

/**
 * GRUPO 2: PROCESAMIENTO TÉCNICO DE ARCHIVOS
 * Funciones encargadas de la apertura de archivos y extracción de datos.
 */

// Extrae fórmulas, metadatos y enlaces de un archivo de Google Sheets.
function performFileAudit(fileId, hojaLog) {
  try {
    const archivo = DriveApp.getFileById(fileId);
    const ss = SpreadsheetApp.openById(fileId);
    const hallazgos = [], hijos = {};
    
    ss.getSheets().forEach(hoja => {
      const rango = hoja.getDataRange();
      const formulas = rango.getFormulas();
      const valores = rango.getDisplayValues();
      
      formulas.forEach((fila, rIdx) => fila.forEach((formula, cIdx) => {
        if (!formula) return;
        const celdaA1 = `${hoja.getName()}!${rango.getCell(rIdx + 1, cIdx + 1).getA1Notation()}`;
        (formula.match(CONFIG.PATRONES.ID_GSHEET) || []).forEach(id => { if (!hijos[id]) hijos[id] = celdaA1; });
        
        let match;
        while ((match = CONFIG.PATRONES.IMPORT_RANGE.exec(formula)) !== null) {
          const idResuelto = resolveDynamicId(match[1].trim(), hoja, ss);
          if (idResuelto?.match?.(CONFIG.PATRONES.ID_GSHEET) && !hijos[idResuelto]) hijos[idResuelto] = celdaA1;
        }
        
        const infoError = getErrorMetadata(valores[rIdx][cIdx]);
        hallazgos.push([
          ss.getName(), celdaA1, infoError.tipo, infoError.nivel, 
          `'${formula.trim()}`, formatDate(archivo.getLastUpdated()), fileId
        ]);
      }));
    });
    log(hojaLog, `✅ ÉXITO: "${ss.getName()}" finalizado. Se extrajeron ${hallazgos.length} registros.`);
    return { 
      nombre: ss.getName(), propietario: archivo.getOwner().getEmail(), 
      actualizado: formatDate(archivo.getLastUpdated()), hallazgos, hijos 
    };
  } catch (e) { 
    // LOG EXTRA 2: Acceso denegado o archivo inexistente
    log(hojaLog, `🚫 ACCESO DENEGADO: No se pudo abrir el ID ${fileId}. Verifique permisos o existencia.`);
    return null; 
  }
}

// Clasifica los errores de las celdas y su nivel de criticidad.
function getErrorMetadata(valor) {
  const str = String(valor).toUpperCase();
  if (!str.startsWith('#') && !str.includes('LOADING')) return { tipo: 'OK', nivel: 'OK' };
  
  for (const [key, nivel] of Object.entries(CONFIG.MAPA_ERRORES)) {
    if (str.includes(key)) return { tipo: key, nivel: nivel };
  }
  return { tipo: 'ERROR', nivel: 'MEDIUM' };
}

// Resuelve una referencia de celda para extraer un ID dinámico.
function resolveDynamicId(referencia, hoja, ssPadre) { 
  try { 
    return (referencia.includes('!') ? ssPadre.getRange(referencia) : hoja.getRange(referencia)).getValue(); 
  } catch(e) { return null; } 
}

/**
 * GRUPO 3: PERSISTENCIA Y UTILIDADES
 * Funciones de apoyo para escritura de datos, logs y formatos de fecha.
 */

// Escribe un conjunto de datos en lotes para optimizar la cuota de Google.
function commitBatch(hoja, datos) {
  for (let i = 0; i < datos.length; i += CONFIG.LIMITES.LOTE_ESCRITURA) {
    const trozo = datos.slice(i, i + CONFIG.LIMITES.LOTE_ESCRITURA);
    hoja.getRange(hoja.getLastRow() + 1, 1, trozo.length, trozo[0].length).setValues(trozo);
  }
}

// Limpia los datos de Details desde el puntero indicado para evitar duplicados.
function rollbackPartialData(hoja, puntero, hojaLog) {
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila >= puntero) {
    log(hojaLog, `↩️ ROLLBACK: Detectada sesión inconclusa. Limpiando desde fila ${puntero} de Details.`);
    hoja.getRange(puntero, 1, ultimaFila - puntero + 1, 7).clearContent();
  }
}

// Verifica o crea la hoja de Logs con sus encabezados correspondientes.
function setupLogSheet() { 
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(CONFIG.SHEETS.LOGS);
  if (!hoja) {
    hoja = ss.insertSheet(CONFIG.SHEETS.LOGS)
             .getRange('A1:B1').setValues([['Timestamp', 'Mensaje']])
             .setFontWeight('bold').getSheet();
  }
  return hoja; 
}

// Registra un evento con la marca de tiempo exacta y formateada (yyyy-MM-dd HH:mm:ss)
function log(hoja, mensaje) { 
  if (hoja) {
    hoja.appendRow([formatDate(new Date()), `'${mensaje}`]); 
  }
}
// Convierte un objeto Date al formato de texto yyyy-MM-dd HH:mm:ss.
function formatDate(fecha) { 
  return Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"); 
}

