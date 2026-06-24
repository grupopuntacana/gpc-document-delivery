<script setup>
import { ref, computed, onMounted } from 'vue'
import { listDocuments, invoiceUrl } from './cap.js'

const docs = ref([])
const loading = ref(true)
const error = ref('')

const groups = [
  { key: 'invoice', title: 'Facturas pendientes', periodLabel: 'Documento' },
  { key: 'energy', title: 'Historial de consumo', periodLabel: 'Periodo' },
  { key: 'other', title: 'Otros documentos', periodLabel: 'Documento' },
]

const byCategory = computed(() => {
  const map = { invoice: [], energy: [], other: [] }
  for (const d of docs.value) (map[d.category] || map.other).push(d)
  return map
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

onMounted(load)
</script>

<template>
  <header>
    <h1>GPC Document Delivery</h1>
    <div class="sub">Portal de documentos · OpenText → CloudFront</div>
  </header>

  <main>
    <div class="toolbar">
      <button class="btn secondary" :disabled="loading" @click="load">
        {{ loading ? 'Cargando…' : 'Refrescar' }}
      </button>
    </div>

    <p v-if="error" class="error">No se pudieron cargar los documentos: {{ error }}</p>

    <section v-for="g in groups" :key="g.key">
      <h2>{{ g.title }}</h2>
      <table>
        <thead>
          <tr><th>{{ g.periodLabel }}</th><th class="right">Tamaño</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-if="!byCategory[g.key].length">
            <td colspan="3" class="empty">{{ loading ? 'Cargando…' : '—' }}</td>
          </tr>
          <tr v-for="d in byCategory[g.key]" :key="d.nodeId">
            <td>
              <div class="name">{{ d.displayName }}</div>
              <div class="subtitle">{{ d.subtitle }}</div>
              <div class="stable-url">/invoice/{{ d.token.slice(0, 18) }}…</div>
            </td>
            <td class="right">{{ formatSize(d.sizeBytes) }}</td>
            <td class="right">
              <a class="btn" :href="invoiceUrl(d.token)" target="_blank" rel="noopener">Open PDF</a>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </main>
</template>

<style scoped>
header { background: #0b2545; color: #fff; padding: 18px 28px; }
header h1 { margin: 0; font-size: 18px; font-weight: 600; }
header .sub { margin-top: 4px; font-size: 13px; opacity: 0.75; }
main { max-width: 1000px; margin: 24px auto; padding: 0 24px; }
.toolbar { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.error { background: #fee2e2; color: #991b1b; padding: 12px 16px; border-radius: 8px; }
section { background: #fff; border: 1px solid #e3e6ec; border-radius: 10px; margin-bottom: 24px; overflow: hidden; }
section h2 { margin: 0; padding: 14px 20px; font-size: 13px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.6px; color: #5a6478; border-bottom: 1px solid #eef0f4; background: #fafbfc; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
td, th { padding: 14px 20px; text-align: left; border-bottom: 1px solid #f0f2f5; }
tr:last-child td { border-bottom: none; }
.right { text-align: right; font-variant-numeric: tabular-nums; }
.name { font-weight: 600; }
.subtitle { font-size: 12px; color: #6b7280; margin-top: 3px; }
.stable-url { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #9aa3b2; margin-top: 4px; }
.empty { color: #6b7280; font-style: italic; }
.btn { display: inline-block; padding: 7px 14px; background: #0b2545; color: #fff; text-decoration: none;
  border-radius: 6px; font-size: 13px; font-weight: 500; border: none; cursor: pointer; }
.btn:hover { background: #163970; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.secondary { background: #6b7280; }
</style>
