<script setup>
import { ref, onMounted } from 'vue'

const books = ref([])

onMounted(async () => {
  const r = await fetch('/odata/v4/catalog/Books')
  books.value = (await r.json()).value
})
</script>

<template>
  <main>
    <h1>Books</h1>
    <table>
      <tr v-for="b in books" :key="b.ID">
        <td>
          <span class="title">{{ b.title }}</span>
          <span class="author"><i> by {{ b.author }}</i></span>
        </td>
      </tr>
    </table>
  </main>
</template>

<style scoped>
.title {
  color: var(--text);
}

.author {
  color: var(--text-muted);
}
</style>
