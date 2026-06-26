<script setup>
import { ref, computed, onMounted } from 'vue'
import { listDocuments, invoiceUrl, uploadDocument, currentUser } from './cap.js'

const docs = ref([])
const user = ref(null)
const loading = ref(true)
const error = ref('')
const uploading = ref(false)
const dragOver = ref(false)
const uploadMsg = ref('')
const uploadErr = ref('')

const groups = [
  { key: 'invoice', title: 'Facturas pendientes', periodLabel: 'Documento', accent: '#1d4e89' },
  { key: 'energy', title: 'Historial de consumo', periodLabel: 'Periodo', accent: '#d98a2b' },
  { key: 'other', title: 'Otros documentos', periodLabel: 'Documento', accent: '#64748b' },
]

const byCategory = computed(() => {
  const map = { invoice: [], energy: [], other: [] }
  for (const d of docs.value) (map[d.category] || map.other).push(d)
  return map
})

const totalDocs = computed(() => docs.value.length)

// i18n-friendly count label (avoids inline pluralization noise in the template).
const docsLabel = computed(() => {
  if (loading.value) return 'Cargando…'
  const n = totalDocs.value
  if (n === 0) return 'Sin documentos'
  return n === 1 ? '1 documento disponible' : `${n} documentos disponibles`
})

// Initials for the avatar — first letters of the first two words, else first two chars.
const initials = computed(() => {
  const n = (user.value?.name || '').trim()
  if (!n) return '·'
  const parts = n.split(/\s+/)
  const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : n.slice(0, 2)
  return chars.toUpperCase()
})

function formatSize(n) {
  if (!n) return '—'
  return n < 1_000_000 ? `${Math.round(n / 1024)} KB` : `${(n / 1_000_000).toFixed(1)} MB`
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    docs.value = await listDocuments()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function upload(file) {
  if (!file) return
  // Any file type is accepted (PDF, photo from the camera, etc.). The backend stores the
  // bytes with the file's own content-type; OTCS keeps it as a generic document node.
  uploading.value = true
  uploadMsg.value = ''
  uploadErr.value = ''
  try {
    const { nodeId, name } = await uploadDocument(file)
    uploadMsg.value = `Subido: ${name} (node ${nodeId})`
    await load() // refresh the listing so the new document appears
  } catch (e) {
    uploadErr.value = e.message
  } finally {
    uploading.value = false
  }
}

function onDrop(e) {
  dragOver.value = false
  upload(e.dataTransfer?.files?.[0])
}

function onPick(e) {
  upload(e.target.files?.[0])
  e.target.value = '' // allow re-uploading the same file
}

// Best-effort: the header still renders if whoami fails (e.g. token without name claims).
async function loadUser() {
  try {
    user.value = await currentUser()
  } catch (e) {
    // Don't block the page, but leave a breadcrumb for prod debugging of a misconfigured whoami.
    console.warn('whoami failed; rendering without user chip:', e.message)
    user.value = null
  }
}

onMounted(() => {
  loadUser()
  load()
})
</script>

<template>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <span class="brand-mark">GPC</span>
        <div class="brand-text">
          <h1>Document Delivery</h1>
          <span class="brand-sub">Portal de documentos · OpenText → CloudFront</span>
        </div>
      </div>

      <div
        v-if="user"
        class="user"
      >
        <span
          class="avatar"
          aria-hidden="true"
        >{{ initials }}</span>
        <span class="user-text">
          <span class="user-name">{{ user.name }}</span>
          <span
            v-if="user.email"
            class="user-email"
          >{{ user.email }}</span>
        </span>
      </div>
    </div>
  </header>

  <main>
    <div class="page-head">
      <div>
        <h2 class="page-title">
          Mis documentos
        </h2>
        <p class="page-meta">
          {{ docsLabel }}
        </p>
      </div>
      <button
        class="btn ghost"
        :disabled="loading"
        @click="load"
      >
        <span :class="{ spin: loading }">⟳</span> Refrescar
      </button>
    </div>

    <div class="upload-row">
      <label
        class="upload-box"
        :class="{ dragover: dragOver, busy: uploading }"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <input
          type="file"
          hidden
          :disabled="uploading"
          @change="onPick"
        >
        <span class="upload-icon">{{ uploading ? '⏳' : '↑' }}</span>
        <span class="upload-text">
          <strong>{{ uploading ? 'Subiendo…' : 'Arrastra un archivo aquí' }}</strong>
          <small v-if="!uploading">o haz clic para seleccionarlo (PDF, imagen, …)</small>
        </span>
      </label>

      <!-- `capture="environment"` opens the rear camera on phones; on desktop it falls back
           to a normal image picker. Separate input so it doesn't override the drag-drop one. -->
      <label
        class="capture-btn"
        :class="{ busy: uploading }"
      >
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          :disabled="uploading"
          @change="onPick"
        >
        <span class="capture-icon">📷</span>
        <span>Tomar foto</span>
      </label>
    </div>

    <transition name="fade">
      <p
        v-if="uploadMsg"
        class="banner ok"
      >
        ✓ {{ uploadMsg }}
      </p>
    </transition>
    <p
      v-if="uploadErr"
      class="banner err"
    >
      No se pudo subir el documento: {{ uploadErr }}
    </p>
    <p
      v-if="error"
      class="banner err"
    >
      No se pudieron cargar los documentos: {{ error }}
    </p>

    <section
      v-for="g in groups"
      :key="g.key"
      class="docgroup"
      :style="{ '--accent': g.accent }"
    >
      <div class="docgroup-head">
        <span class="docgroup-bar" />
        <h3>{{ g.title }}</h3>
        <span class="count">{{ byCategory[g.key].length }}</span>
      </div>

      <p
        v-if="!byCategory[g.key].length"
        class="docgroup-empty"
      >
        {{ loading ? 'Cargando…' : 'Sin documentos en esta categoría' }}
      </p>

      <ul
        v-else
        class="doc-list"
      >
        <li
          v-for="(d, i) in byCategory[g.key]"
          :key="d.nodeId"
          class="doc"
          :style="{ animationDelay: `${i * 35}ms` }"
        >
          <span
            class="doc-icon"
            aria-hidden="true"
          >PDF</span>
          <div class="doc-main">
            <div class="doc-name">
              {{ d.displayName }}
            </div>
            <div
              v-if="d.subtitle"
              class="doc-sub"
            >
              {{ d.subtitle }}
            </div>
            <div class="doc-url">
              /invoice/{{ d.token.slice(0, 16) }}…
            </div>
          </div>
          <span class="doc-size">{{ formatSize(d.sizeBytes) }}</span>
          <a
            class="btn primary doc-open"
            :href="invoiceUrl(d.token)"
            target="_blank"
            rel="noopener"
          >Abrir</a>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
/* ---- Top bar ---------------------------------------------------------- */
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  background: linear-gradient(120deg, var(--navy) 0%, #123a6b 100%);
  color: #fff;
  box-shadow: var(--shadow-md);
}
.topbar-inner {
  max-width: 1040px;
  margin: 0 auto;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; }
.brand-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px; height: 42px;
  font-family: var(--display);
  font-weight: 600;
  font-size: 15px;
  letter-spacing: 0.5px;
  color: var(--navy);
  background: linear-gradient(150deg, #fff 0%, #ffe9c7 100%);
  border-radius: 11px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4);
}
.brand-text { min-width: 0; }
.brand h1 {
  margin: 0;
  font-family: var(--display);
  font-weight: 600;
  font-size: 20px;
  line-height: 1.1;
  letter-spacing: 0.2px;
}
.brand-sub {
  display: block;
  margin-top: 2px;
  font-size: 12.5px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* User chip */
.user { display: flex; align-items: center; gap: 11px; min-width: 0; }
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px; height: 38px;
  border-radius: 50%;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--navy);
  background: linear-gradient(150deg, #ffd89e 0%, var(--amber) 100%);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.18);
}
.user-text { display: flex; flex-direction: column; line-height: 1.25; min-width: 0; }
.user-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user-email { font-size: 12px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- Main ------------------------------------------------------------- */
main { max-width: 1040px; margin: 0 auto; padding: 28px 24px 64px; }

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.page-title {
  margin: 0;
  font-family: var(--display);
  font-weight: 600;
  font-size: 26px;
  letter-spacing: 0.2px;
}
.page-meta { margin: 4px 0 0; font-size: 13.5px; color: var(--ink-muted); }

/* ---- Buttons ---------------------------------------------------------- */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: none;
  border-radius: 9px;
  font-family: var(--sans);
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.15s, transform 0.08s, box-shadow 0.15s;
  white-space: nowrap;
}
.btn:active { transform: translateY(1px); }
.btn.primary { padding: 9px 16px; background: var(--navy); color: #fff; box-shadow: var(--shadow-sm); }
.btn.primary:hover { background: var(--navy-700); }
.btn.ghost { padding: 8px 14px; background: #fff; color: var(--navy); box-shadow: inset 0 0 0 1px var(--line); }
.btn.ghost:hover { background: var(--navy-50); }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.spin { display: inline-block; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---- Upload dropzone -------------------------------------------------- */
.upload-row {
  display: flex;
  align-items: stretch;
  gap: 12px;
  margin-bottom: 18px;
}
.upload-box {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 22px;
  border: 1.5px dashed #b9c4d8;
  border-radius: 14px;
  background:
    linear-gradient(180deg, #fff 0%, #fbfcfe 100%);
  color: var(--ink-muted);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.upload-box:hover { border-color: var(--navy); box-shadow: var(--shadow-sm); }

/* Camera-capture shortcut (rear camera on phones, image picker on desktop). */
.capture-btn {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 104px;
  padding: 12px;
  border-radius: 14px;
  background: var(--navy);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
  box-shadow: var(--shadow-sm);
}
.capture-btn:hover { background: var(--navy-700); }
.capture-btn.busy { opacity: 0.6; cursor: progress; }
.capture-icon { font-size: 22px; line-height: 1; }
.upload-box.dragover { border-color: var(--amber); background: var(--amber-50); }
.upload-box.busy { opacity: 0.7; cursor: progress; }
.upload-icon {
  flex: none;
  display: grid; place-items: center;
  width: 44px; height: 44px;
  font-size: 20px; font-weight: 700;
  color: var(--navy);
  background: var(--navy-50);
  border-radius: 12px;
}
.upload-box.dragover .upload-icon { color: var(--amber); background: #fff; }
.upload-text { display: flex; flex-direction: column; }
.upload-text strong { font-size: 14.5px; color: var(--ink); font-weight: 600; }
.upload-text small { font-size: 12.5px; }

/* ---- Banners ---------------------------------------------------------- */
.banner {
  margin: 0 0 16px;
  padding: 11px 16px;
  border-radius: 10px;
  font-size: 13.5px;
  font-weight: 500;
}
.banner.ok { background: var(--ok-bg); color: var(--ok-fg); }
.banner.err { background: var(--err-bg); color: var(--err-fg); }
.fade-enter-active { transition: opacity 0.25s; }
.fade-enter-from { opacity: 0; }

/* ---- Document groups -------------------------------------------------- */
.docgroup {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
  margin-bottom: 18px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.docgroup-head {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 15px 20px;
  border-bottom: 1px solid var(--line-soft);
}
.docgroup-bar {
  width: 4px; height: 18px;
  border-radius: 4px;
  background: var(--accent);
}
.docgroup-head h3 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.count {
  margin-left: auto;
  min-width: 22px;
  padding: 2px 8px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  background: var(--line-soft); /* fallback for browsers without color-mix */
  background: color-mix(in srgb, var(--accent) 12%, #fff);
  border-radius: 999px;
}
.docgroup-empty {
  margin: 0;
  padding: 22px 20px;
  font-size: 13.5px;
  color: var(--ink-faint);
  font-style: italic;
}

.doc-list { list-style: none; margin: 0; padding: 0; }
.doc {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line-soft);
  animation: rise 0.4s both;
}
.doc:last-child { border-bottom: none; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }

.doc-icon {
  flex: none;
  display: grid; place-items: center;
  width: 40px; height: 40px;
  font-size: 10px; font-weight: 800; letter-spacing: 0.5px;
  color: var(--accent);
  background: var(--line-soft); /* fallback for browsers without color-mix */
  background: color-mix(in srgb, var(--accent) 10%, #fff);
  border-radius: 10px;
}
.doc-main { flex: 1; min-width: 0; }
.doc-name { font-size: 14.5px; font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
.doc-sub { font-size: 12.5px; color: var(--ink-muted); margin-top: 2px; }
.doc-url { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); margin-top: 4px; }
.doc-size {
  flex: none;
  font-size: 13px;
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
  min-width: 64px;
  text-align: right;
}
.doc-open { flex: none; }

/* ---- Responsive: stack rows so "Abrir PDF" is always reachable --------- */
@media (max-width: 600px) {
  .topbar-inner { padding: 12px 16px; gap: 12px; }
  .brand-sub { display: none; }
  .brand h1 { font-size: 17px; }
  .brand-mark { width: 38px; height: 38px; }
  .user-email { display: none; }           /* keep avatar + full name, drop email to save width */
  .user-name { max-width: 38vw; }
  main { padding: 20px 16px 56px; }
  .page-title { font-size: 22px; }

  .doc {
    flex-wrap: wrap;
    align-items: flex-start;
    row-gap: 12px;
  }
  .doc-main { flex: 1 1 100%; order: 1; }
  .doc-icon { order: 0; }
  .doc-size { order: 2; min-width: 0; text-align: left; flex: 1; align-self: center; }
  .doc-open {
    order: 3;
    align-self: center;
    padding: 10px 16px;          /* larger tap target */
  }
}
</style>
