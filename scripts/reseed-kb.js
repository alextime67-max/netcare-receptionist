const { db, initDb } = require('../src/database/db');
const mdcare = db.prepare("SELECT id FROM clinics WHERE slug = 'mdcare'").get();
if (mdcare) {
  db.prepare('DELETE FROM knowledge_base WHERE clinic_id = ?').run(mdcare.id);
  console.log('Deleted stale KB row for MDcare');
}
initDb();
const kb = db.prepare('SELECT services FROM knowledge_base WHERE clinic_id = ?').get(mdcare?.id);
console.log('KB re-seeded. Services preview:', kb?.services?.substring(0, 80) || 'NULL');
