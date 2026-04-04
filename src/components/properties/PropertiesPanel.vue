<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementStore } from '@/store/element'
import { ElementKind, type CanvasElement, type SolidPaint } from '@/types/element'

// ── Store ─────────────────────────────────────────────────────────────────────

const elementStore = useElementStore()

// ── Computed ──────────────────────────────────────────────────────────────────

/** 單選元素；0 個或多選時為 null。 */
const el = computed<CanvasElement | null>(() => {
  const selected = elementStore.selectedElements
  return selected.length === 1 ? selected[0] : null
})

// ── 欄位最小值限制（避免無效尺寸傳入渲染引擎） ──────────────────────────────────

const FIELD_MIN: Partial<Record<keyof CanvasElement, number>> = {
  width:        1,
  height:       1,
  strokeWidth:  0,
  cornerRadius: 0,
  fontSize:     1,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function toPercent(opacity: number): number {
  return Math.round(opacity * 100)
}

function kindLabel(kind: ElementKind): string {
  switch (kind) {
    case ElementKind.Rect:      return 'Rectangle'
    case ElementKind.Ellipse:   return 'Ellipse'
    case ElementKind.Line:      return 'Line'
    case ElementKind.Polygon:   return 'Polygon'
    case ElementKind.Text:      return 'Text'
    case ElementKind.Frame:     return 'Frame'
    case ElementKind.Group:     return 'Group'
    case ElementKind.Component: return 'Component'
    default:                    return 'Element'
  }
}

/** 從 Paint 安全取出 SolidPaint；若不是 solid 則回傳 null。 */
function asSolid(paint: CanvasElement['fill'] | undefined): SolidPaint | null {
  return paint?.type === 'solid' ? paint : null
}

// ── 顏色快照顆粒度：記錄拾色器開啟時的顏色，僅在顏色真正改變時才推 snapshot ──

const _colorAtOpen = ref<Record<'fill' | 'stroke', string>>({ fill: '', stroke: '' })

function onColorPickerOpen(field: 'fill' | 'stroke'): void {
  const solid = asSolid(el.value?.[field])
  _colorAtOpen.value[field] = solid?.color ?? ''
}

// ── Update Handlers ───────────────────────────────────────────────────────────

/**
 * 通用數值欄位更新。
 * 套用 FIELD_MIN 下限保護，避免傳入 0 或負值給渲染引擎（如 width/height）。
 */
function onNumericFieldChange(field: keyof CanvasElement, event: Event): void {
  if (!el.value) return
  const raw = parseFloat((event.target as HTMLInputElement).value)
  if (isNaN(raw)) return
  const min = FIELD_MIN[field]
  const val = min !== undefined ? Math.max(min, raw) : raw
  elementStore.commitUpdate(el.value.id, { [field]: val } as Partial<CanvasElement>)
}

/** Opacity：UI 以百分比 (0–100) 輸入，clamp 後換算至 0–1 存入 store。 */
function onOpacityChange(event: Event): void {
  if (!el.value) return
  const pct = parseFloat((event.target as HTMLInputElement).value)
  if (isNaN(pct)) return
  const clamped = Math.max(0, Math.min(100, pct)) / 100
  elementStore.commitUpdate(el.value.id, { opacity: clamped })
}

/** 拾色器拖曳中：live update，不推 snapshot（效能優化）。 */
function onColorPreview(field: 'fill' | 'stroke', event: Event): void {
  if (!el.value) return
  const existing = asSolid(el.value[field])
  if (!existing) return
  const color = (event.target as HTMLInputElement).value
  elementStore.update(el.value.id, { [field]: { ...existing, color } })
}

/** 拾色器關閉：僅當顏色真正改變時才推 snapshot，避免冗餘 undo 項目。 */
function onColorCommit(field: 'fill' | 'stroke'): void {
  if (!el.value) return
  const solid = asSolid(el.value[field])
  if (solid && solid.color !== _colorAtOpen.value[field]) {
    elementStore.pushSnapshot()
  }
}

/** Hex 文字輸入確認（update + snapshot 合一）。 */
function onHexChange(field: 'fill' | 'stroke', event: Event): void {
  if (!el.value) return
  const existing = asSolid(el.value[field])
  if (!existing) return
  const color = (event.target as HTMLInputElement).value.trim()
  if (!color) return
  elementStore.commitUpdate(el.value.id, { [field]: { ...existing, color } })
}

/** fontFamily：過濾空字串，避免文字消失。 */
function onFontFamilyChange(event: Event): void {
  if (!el.value) return
  const val = (event.target as HTMLInputElement).value.trim()
  if (!val) return
  elementStore.commitUpdate(el.value.id, { fontFamily: val })
}
</script>

<template>
  <div class="props-panel">
    <template v-if="el">

      <!-- Kind header -->
      <div class="props-kind">{{ kindLabel(el.kind) }}</div>

      <!-- Position & Size -->
      <section class="props-section">
        <div class="props-grid-2">
          <label class="props-field">
            <span class="props-label">X</span>
            <input type="number" :value="round(el.x)" @change="onNumericFieldChange('x', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">Y</span>
            <input type="number" :value="round(el.y)" @change="onNumericFieldChange('y', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">W</span>
            <input type="number" min="1" :value="round(el.width)" @change="onNumericFieldChange('width', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">H</span>
            <input type="number" min="1" :value="round(el.height)" @change="onNumericFieldChange('height', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">°</span>
            <input type="number" :value="round(el.rotation)" @change="onNumericFieldChange('rotation', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">Opacity</span>
            <input type="number" min="0" max="100" :value="toPercent(el.opacity)" @change="onOpacityChange($event)">
            <span class="props-unit">%</span>
          </label>
        </div>
      </section>

      <!-- Fill (hidden for Line) -->
      <section v-if="el.kind !== ElementKind.Line" class="props-section">
        <div class="props-section-title">Fill</div>
        <div class="props-color-row">
          <input
            type="color"
            class="props-color-swatch"
            :value="asSolid(el.fill)?.color || '#000000'"
            @mousedown="onColorPickerOpen('fill')"
            @input="onColorPreview('fill', $event)"
            @change="onColorCommit('fill')"
          >
          <input
            type="text"
            class="props-hex"
            :value="asSolid(el.fill)?.color ?? ''"
            placeholder="#——"
            @change="onHexChange('fill', $event)"
          >
        </div>
      </section>

      <!-- Stroke -->
      <section class="props-section">
        <div class="props-section-title">Stroke</div>
        <div class="props-color-row">
          <input
            type="color"
            class="props-color-swatch"
            :value="asSolid(el.stroke)?.color || '#000000'"
            @mousedown="onColorPickerOpen('stroke')"
            @input="onColorPreview('stroke', $event)"
            @change="onColorCommit('stroke')"
          >
          <input
            type="text"
            class="props-hex"
            :value="asSolid(el.stroke)?.color ?? ''"
            placeholder="#——"
            @change="onHexChange('stroke', $event)"
          >
          <label class="props-field props-stroke-w">
            <input type="number" min="0" :value="el.strokeWidth" @change="onNumericFieldChange('strokeWidth', $event)">
          </label>
        </div>
      </section>

      <!-- Corner Radius (Rect / Frame only) -->
      <section
        v-if="el.kind === ElementKind.Rect || el.kind === ElementKind.Frame"
        class="props-section"
      >
        <div class="props-section-title">Corner Radius</div>
        <label class="props-field">
          <input
            type="number"
            min="0"
            :value="el.cornerRadius ?? 0"
            @change="onNumericFieldChange('cornerRadius', $event)"
          >
        </label>
      </section>

      <!-- Typography (Text only) -->
      <section v-if="el.kind === ElementKind.Text" class="props-section">
        <div class="props-section-title">Typography</div>
        <div class="props-grid-2">
          <label class="props-field">
            <span class="props-label">Size</span>
            <input
              type="number"
              min="1"
              :value="el.fontSize ?? 14"
              @change="onNumericFieldChange('fontSize', $event)"
            >
          </label>
          <label class="props-field props-field--wide">
            <span class="props-label">Font</span>
            <input
              type="text"
              :value="el.fontFamily ?? 'Inter'"
              @change="onFontFamilyChange($event)"
            >
          </label>
        </div>
      </section>

    </template>

    <div v-else class="props-empty">選取圖形以查看屬性</div>
  </div>
</template>

<style src="./PropertiesPanel.scss" lang="scss" />
