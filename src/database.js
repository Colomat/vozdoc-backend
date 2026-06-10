import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '../tesis.db');

export async function conectarDB() {
  return open({ filename: DB_PATH, driver: sqlite3.Database });
}

export async function inicializarDB() {
  const db = await conectarDB();

  // Crear tabla si no existe — con columna categoria
  await db.exec(`
    CREATE TABLE IF NOT EXISTS historial (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_archivo  TEXT    NOT NULL,
      texto_resumen   TEXT    NOT NULL,
      categoria       TEXT    NOT NULL DEFAULT 'otros',
      fecha_creacion  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migración: si la tabla ya existe sin la columna categoria, la agregamos
  const columnas = await db.all("PRAGMA table_info(historial)");
  const tieneCategoria = columnas.some((c) => c.name === 'categoria');
  if (!tieneCategoria) {
    await db.exec("ALTER TABLE historial ADD COLUMN categoria TEXT NOT NULL DEFAULT 'otros'");
    console.log("🔧 Migración: columna 'categoria' agregada a la tabla historial.");
  }

  console.log("🗄️ Base de datos SQLite inicializada y tabla 'historial' lista.");
  await db.close();
}