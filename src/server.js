import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { inicializarDB, conectarDB } from './database.js';

const app  = express();
const PORT = process.env.PORT || 5000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyDcohq4_KmyUFK6dUTVajPYAb-Dx-tgeiA";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const fileFilter = (req, file, cb) => {
  const permitidos = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
  permitidos.includes(file.mimetype) ? cb(null, true) : cb(new Error('Formato no soportado.'), false);
};
const upload = multer({ storage, fileFilter });

function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
      mimeType,
    },
  };
}

// ─── Categorías válidas ────────────────────────────────────────────────────
const CATEGORIAS_VALIDAS = ['receta', 'boleta', 'turno', 'legal', 'otros'];

// ─── Llamada a Gemini con reintentos ──────────────────────────────────────
async function llamarGeminiConReintentos(contenidos, maxIntentos = 3, esperaMs = 3000) {
  let ultimoError;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      console.log(`🤖 Intento ${intento} de ${maxIntentos} con Gemini...`);
      const respuesta = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contenidos,
      });
      return respuesta.text;
    } catch (error) {
      ultimoError = error;
      const reintentable = error?.message?.includes('503') || error?.message?.includes('429') || error?.status === 503 || error?.status === 429;
      if (reintentable && intento < maxIntentos) {
        const espera = esperaMs * intento;
        console.warn(`⚠️  Gemini ocupado (${error?.status}). Reintentando en ${espera / 1000}s...`);
        await new Promise((r) => setTimeout(r, espera));
      } else {
        throw ultimoError;
      }
    }
  }
}

// ─── POST: procesar documento ─────────────────────────────────────────────
app.post('/api/procesar-documento', upload.single('documento'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibió ningún archivo o el formato es inválido.' });
  }

  const rutaArchivo     = req.file.path;
  const mimeTypeArchivo = req.file.mimetype;
  const nombreOriginal  = req.file.originalname;

  console.log(`📂 Archivo recibido: ${nombreOriginal}. Enviando a Gemini...`);

  try {
    const archivoParaIA = fileToGenerativePart(rutaArchivo, mimeTypeArchivo);

    // ── 1. Resumen accesible ──────────────────────────────────────────────
    const textoSimplificado = await llamarGeminiConReintentos([
      archivoParaIA,
      {
        text: `
  Actúas como un experto en accesibilidad cognitiva y lingüística para adultos mayores.
  Tu objetivo es analizar el documento adjunto y simplificarlo drásticamente para que cualquier persona lo entienda al escucharlo una sola vez.

  INSTRUCCIONES DE CONTENIDO:
  1. Identificá de forma directa qué tipo de documento es (ej: boleta de luz, receta médica, contrato de alquiler, certificado, etc.).
  2. Extraé los datos más importantes según el tipo de documento:
     - Si tiene montos → decí cuánto es y para qué.
     - Si tiene fechas → decí cuándo vence, cuándo tomarlo, o cuándo es el evento.
     - Si es un documento legal o contractual → decí las partes involucradas y lo más relevante.
     - Si es un análisis o estudio médico → decí los resultados clave.
     - Para cualquier otro documento → extraé lo esencial para entenderlo.
  3. Ignorá códigos de barra, datos fiscales irrelevantes, tablas secundarias o textos legales redundantes.

  INSTRUCCIONES CRÍTICAS PARA SINTETIZADOR DE VOZ (LECTURA):
  - Escribí en lenguaje ultra-simple, con oraciones cortas y un tono amigable y pausado.
  - NO uses listas numeradas, viñetas (*), guiones ni títulos rígidos. Redactalo como un párrafo continuo separado por puntos seguidos.
  - FORMATO DE NÚMEROS: Transcribí montos y fechas a texto hablado natural. Ej:
    * "$14.500" → "14 mil 500 pesos"
    * "15/08" → "15 de agosto"
    * "12:30 hs" → "doce y media del mediodía"

  MANEJO DE ERRORES:
  - Si la imagen está borrosa o no se entiende, respondé: "La foto del documento no se ve muy clara. Por favor, intentá sacarle otra foto enfocando bien el papel."
`
      },
    ]);

    // ── 2. Clasificación de categoría ────────────────────────────────────
    // Llamada separada y liviana solo para clasificar
    const respuestaCategoria = await llamarGeminiConReintentos([
      archivoParaIA,
      {
        text: `Analizá este documento y clasificalo en UNA de estas categorías:
- receta     → si es una receta médica, indicación médica o prescripción de medicamentos. 
- boleta     → si es una boleta, factura, servicio (luz, gas, agua, teléfono, expensas, impuestos)
- turno      → si es un turno médico, cita, orden de estudio, resultado de análisis
- legal      → si es un contrato, escritura, documento notarial, poder, acta, DNI, cédula
- otros      → cualquier otro tipo de documento

Respondé ÚNICAMENTE con una de estas palabras exactas, sin puntuación ni explicación:
receta | boleta | turno | legal | otros`,
      },
    ]);

    const categoriaDetectada = respuestaCategoria.trim().toLowerCase().replace(/[^a-z]/g, '');
    const categoria = CATEGORIAS_VALIDAS.includes(categoriaDetectada) ? categoriaDetectada : 'otros';
    console.log(`🏷️  Categoría detectada: ${categoria}`);

    fs.unlinkSync(rutaArchivo);

    const db = await conectarDB();
    await db.run(
      'INSERT INTO historial (nombre_archivo, texto_resumen, categoria) VALUES (?, ?, ?)',
      [nombreOriginal, textoSimplificado, categoria]
    );
    console.log('🗄️ Resumen guardado en la base de datos.');

    res.json({ success: true, textoProcesado: textoSimplificado, categoria });

  } catch (error) {
    console.error('❌ Error al procesar con Gemini:', error);
    if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);

    const es503 = error?.message?.includes('503');
    const es429 = error?.message?.includes('429');
    const mensaje = es503
      ? 'El servicio de IA está temporalmente saturado. Intentá de nuevo en unos minutos.'
      : es429
      ? 'Se superó el límite de uso de la IA. Esperá unos minutos e intentá de nuevo.'
      : 'Hubo un problema al analizar el documento.';

    res.status(500).json({ success: false, error: mensaje });
  }
});

// ─── GET: historial ───────────────────────────────────────────────────────
app.get('/api/historial', async (req, res) => {
  try {
    const db = await conectarDB();
    const registros = await db.all('SELECT * FROM historial ORDER BY fecha_creacion DESC');
    res.json({ success: true, historial: registros });
  } catch (error) {
    console.error('❌ Error al consultar la base de datos:', error);
    res.status(500).json({ error: 'No se pudo obtener el historial.' });
  }
});

// ─── DELETE: eliminar registro ────────────────────────────────────────────
app.delete('/api/historial/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const db        = await conectarDB();
    const resultado = await db.run('DELETE FROM historial WHERE id = ?', id);
    if (resultado.changes === 0) {
      return res.status(404).json({ success: false, error: 'No se encontró el registro.' });
    }
    console.log(`🗑️ Registro ID ${id} eliminado.`);
    res.json({ success: true, message: 'Registro eliminado correctamente.' });
  } catch (error) {
    console.error('❌ Error al eliminar:', error);
    res.status(500).json({ error: 'No se pudo eliminar el registro.' });
  }
});



// ── Responder preguntas por voz sobre el documento ──
app.post('/api/preguntar-documento', async (req, res) => {
  const { resumenDocumento, preguntaUsuario, categoria } = req.body;
  const cat = categoria || 'otros';

  if (!resumenDocumento || !preguntaUsuario) {
    return res.status(400).json({ error: "Faltan datos para procesar la pregunta." });
  }

  try {
    console.log(`🎙️ Pregunta recibida de la app: "${preguntaUsuario}" (categoría: ${cat})`);

    const respuestaIA = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          text: `
            Actúas como un asistente de voz ultra simple para adultos mayores.
            Te proporciono el resumen de un documento (categoría: "${cat}"):
            "${resumenDocumento}"

            El usuario te hace esta pregunta por voz: "${preguntaUsuario}"

            INSTRUCCIONES DE RESPUESTA:
            Respondé de forma clara, amigable y completa. Podés usar tu conocimiento general para explicar conceptos o términos que aparezcan en el documento aunque no estén detallados ahí.
            - Si preguntan qué significa algo (un producto, un término, un concepto), EXPLICÁLO con tu conocimiento general en lenguaje simple.
            - Si preguntan por montos, fechas o datos específicos del documento, respondé con lo que dice el resumen.
            - Si preguntan por más detalles de algo mencionado en el resumen, ampliá con tu conocimiento general.
            - Si directamente no sabés la respuesta o no hay información, decí que no tenés ese dato.
            - Respuesta corta, sin saludos ni introducciones. Ideal para leerlo en voz alta.
          `
        }
      ],
    });

    const respuestaVoz = respuestaIA.text.trim();
    console.log(`🤖 Respuesta de Gemini para locución: "${respuestaVoz}"`);

    res.json({ success: true, respuestaVoz });

  } catch (error) {
    console.error("❌ Error al procesar la pregunta conversacional:", error);
    res.status(500).json({ error: "No se pudo procesar la pregunta por voz." });
  }
});









// ─── ARRANQUE ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Servidor VozDoc corriendo en http://localhost:${PORT}`);
  try {
    await inicializarDB();
  } catch (error) {
    console.error('❌ Error al inicializar la base de datos:', error);
  }
});