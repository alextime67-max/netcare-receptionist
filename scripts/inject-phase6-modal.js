/**
 * 1. Adds call-detail-modal HTML before </body>
 * 2. Calls populateCallClinicFilter() inside loadClients()
 */
const fs   = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../src/public/superadmin.html');
let c = fs.readFileSync(htmlPath, 'utf8');

// ── 1. Add modal before </body> ───────────────────────────────────────────────
if (!c.includes('call-detail-modal')) {
  const modalHtml = `
<!-- ── Call Detail Modal ─────────────────────────────────────────────────── -->
<div id="call-detail-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
  <div class="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-100">
      <h3 class="font-bold text-slate-800 text-lg">Call Detail</h3>
      <button onclick="closeCallDetail()" class="text-slate-400 hover:text-slate-600 text-xl leading-none">&times;</button>
    </div>
    <div id="call-detail-body" class="flex-1 overflow-y-auto px-6 py-4 text-sm text-slate-700">
      Loading…
    </div>
    <div class="px-6 py-3 border-t border-slate-100 flex justify-end">
      <button onclick="closeCallDetail()" class="px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition">Close</button>
    </div>
  </div>
</div>

`;
  c = c.replace('</body>', modalHtml + '</body>');
  console.log('✓ Call detail modal added');
} else {
  console.log('  Call detail modal already present, skipping');
}

// ── 2. Call populateCallClinicFilter after clients are loaded ─────────────────
const LOAD_CLIENTS_MARKER = 'allClients = data;';
if (c.includes(LOAD_CLIENTS_MARKER) && !c.includes('populateCallClinicFilter')) {
  c = c.replace(LOAD_CLIENTS_MARKER, 'allClients = data;\n      populateCallClinicFilter();');
  console.log('✓ populateCallClinicFilter() wired into loadClients');
} else {
  console.log('  populateCallClinicFilter already wired or marker not found');
}

// ── 3. Wire Enter key on wsim-input ──────────────────────────────────────────
const wsimInputMarker = "document.addEventListener('keydown', function(e) {";
if (c.includes(wsimInputMarker) && !c.includes('wsim-input') ) {
  // skip — already handled
}
// Add keydown on wsim-input via onkeydown attribute in HTML (done in HTML panel)

fs.writeFileSync(htmlPath, c, 'utf8');
console.log('Done.');
