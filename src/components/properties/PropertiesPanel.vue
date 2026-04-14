<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementStore } from '@/store/element'
import {
  ElementKind,
  type CanvasElement,
  type FontWeight,
  type SolidPaint,
  type TextAlign,
  ELEMENT_DEFAULT_FONT_FAMILY,
  ELEMENT_DEFAULT_FONT_SIZE,
  ELEMENT_DEFAULT_FONT_WEIGHT,
  ELEMENT_DEFAULT_LETTER_SPACING,
  ELEMENT_DEFAULT_LINE_HEIGHT,
  ELEMENT_DEFAULT_TEXT_ALIGN,
} from '@/types/element'

const elementStore = useElementStore()

const FIELD_MIN: Partial<Record<keyof CanvasElement, number>> = {
  width: 1,
  height: 1,
  strokeWidth: 0,
  cornerRadius: 0,
  fontSize: 1,
  lineHeight: 0.5,
  letterSpacing: 0,
}

const FONT_FAMILY_OPTIONS = ['Inter', 'Arial', 'Noto Sans TC', 'Roboto', 'Helvetica Neue', 'monospace']
const FONT_WEIGHT_OPTIONS: Array<{ label: string; value: FontWeight }> = [
  { label: 'Thin', value: 100 },
  { label: 'Extra Light', value: 200 },
  { label: 'Light', value: 300 },
  { label: 'Regular', value: 400 },
  { label: 'Medium', value: 500 },
  { label: 'Semi Bold', value: 600 },
  { label: 'Bold', value: 700 },
  { label: 'Extra Bold', value: 800 },
  { label: 'Black', value: 900 },
]
const TEXT_ALIGN_OPTIONS: Array<{ label: string; value: TextAlign }> = [
  { label: 'Left', value: 'left' },
  { label: 'Center', value: 'center' },
  { label: 'Right', value: 'right' },
]
const DEFAULT_COLOR_HEX = '#000000'
const EMPTY_SELECTION_MESSAGE = '選取一個物件後即可編輯屬性'

const el = computed<CanvasElement | null>(() => {
  const selected = elementStore.selectedElements
  return selected.length === 1 ? selected[0] : null
})

const _colorAtOpen = ref<Record<'fill' | 'stroke', string>>({ fill: '', stroke: '' })

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function toPercent(opacity: number): number {
  return Math.round(opacity * 100)
}

function kindLabel(kind: ElementKind): string {
  switch (kind) {
    case ElementKind.Rect: return 'Rectangle'
    case ElementKind.Ellipse: return 'Ellipse'
    case ElementKind.Line: return 'Line'
    case ElementKind.Polygon: return 'Polygon'
    case ElementKind.Vector: return 'Vector'
    case ElementKind.Text: return 'Text'
    case ElementKind.Frame: return 'Frame'
    case ElementKind.Group: return 'Group'
    case ElementKind.Component: return 'Component'
    default: return 'Element'
  }
}

function asSolid(paint: CanvasElement['fill'] | undefined): SolidPaint | null {
  return paint?.type === 'solid' ? paint : null
}

function onColorPickerOpen(field: 'fill' | 'stroke'): void {
  const solid = asSolid(el.value?.[field])
  _colorAtOpen.value[field] = solid?.color ?? ''
}

function onNumericFieldChange(field: keyof CanvasElement, event: Event): void {
  if (!el.value) return
  const raw = parseFloat((event.target as HTMLInputElement).value)
  if (isNaN(raw)) return
  const min = FIELD_MIN[field]
  const value = min !== undefined ? Math.max(min, raw) : raw
  elementStore.commitUpdate(el.value.id, { [field]: value } as Partial<CanvasElement>)
}

function onOpacityChange(event: Event): void {
  if (!el.value) return
  const pct = parseFloat((event.target as HTMLInputElement).value)
  if (isNaN(pct)) return
  const clamped = Math.max(0, Math.min(100, pct)) / 100
  elementStore.commitUpdate(el.value.id, { opacity: clamped })
}

function onColorPreview(field: 'fill' | 'stroke', event: Event): void {
  if (!el.value) return
  const existing = asSolid(el.value[field])
  if (!existing) return
  const color = (event.target as HTMLInputElement).value
  elementStore.update(el.value.id, { [field]: { ...existing, color } })
}

function onColorCommit(field: 'fill' | 'stroke'): void {
  if (!el.value) return
  const solid = asSolid(el.value[field])
  if (solid && solid.color !== _colorAtOpen.value[field]) {
    elementStore.pushSnapshot()
  }
}

function onHexChange(field: 'fill' | 'stroke', event: Event): void {
  if (!el.value) return
  const existing = asSolid(el.value[field])
  if (!existing) return
  const color = (event.target as HTMLInputElement).value.trim()
  if (!color) return
  elementStore.commitUpdate(el.value.id, { [field]: { ...existing, color } })
}

function onFontFamilyChange(event: Event): void {
  if (!el.value) return
  const value = (event.target as HTMLInputElement).value.trim()
  if (!value) return
  elementStore.commitUpdate(el.value.id, { fontFamily: value })
}

function onFontWeightChange(event: Event): void {
  if (!el.value) return
  const value = Number((event.target as HTMLSelectElement).value) as FontWeight
  elementStore.commitUpdate(el.value.id, { fontWeight: value })
}

function setTextAlign(align: TextAlign): void {
  if (!el.value) return
  elementStore.commitUpdate(el.value.id, { textAlign: align })
}
</script>

<template>
  <div class="props-panel">
    <template v-if="el">
      <div class="props-kind">{{ kindLabel(el.kind) }}</div>

      <section class="props-section">
        <div class="props-section-title">Position</div>
        <div class="props-grid-2">
          <label class="props-field">
            <span class="props-label">X</span>
            <input type="number" :value="round(el.x)" @change="onNumericFieldChange('x', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">Y</span>
            <input type="number" :value="round(el.y)" @change="onNumericFieldChange('y', $event)">
          </label>
        </div>
        <div class="props-grid-2 props-grid-2--spaced">
          <label class="props-field">
            <span class="props-label">Rotation</span>
            <input type="number" :value="round(el.rotation)" @change="onNumericFieldChange('rotation', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">Opacity</span>
            <input type="number" min="0" max="100" :value="toPercent(el.opacity)" @change="onOpacityChange($event)">
            <span class="props-unit">%</span>
          </label>
        </div>
      </section>

      <section class="props-section">
        <div class="props-section-title">Layout</div>
        <div class="props-grid-2">
          <label class="props-field">
            <span class="props-label">W</span>
            <input type="number" min="1" :value="round(el.width)" @change="onNumericFieldChange('width', $event)">
          </label>
          <label class="props-field">
            <span class="props-label">H</span>
            <input type="number" min="1" :value="round(el.height)" @change="onNumericFieldChange('height', $event)">
          </label>
        </div>
      </section>

      <section v-if="el.kind !== ElementKind.Line" class="props-section">
        <div class="props-section-title">Fill</div>
        <div class="props-color-row">
          <input
            type="color"
            class="props-color-swatch"
            :value="asSolid(el.fill)?.color || DEFAULT_COLOR_HEX"
            @mousedown="onColorPickerOpen('fill')"
            @input="onColorPreview('fill', $event)"
            @change="onColorCommit('fill')"
          >
          <input
            type="text"
            class="props-hex"
            :value="asSolid(el.fill)?.color ?? ''"
            :placeholder="DEFAULT_COLOR_HEX"
            @change="onHexChange('fill', $event)"
          >
        </div>
      </section>

      <section class="props-section">
        <div class="props-section-title">Stroke</div>
        <div class="props-color-row">
          <input
            type="color"
            class="props-color-swatch"
            :value="asSolid(el.stroke)?.color || DEFAULT_COLOR_HEX"
            @mousedown="onColorPickerOpen('stroke')"
            @input="onColorPreview('stroke', $event)"
            @change="onColorCommit('stroke')"
          >
          <input
            type="text"
            class="props-hex"
            :value="asSolid(el.stroke)?.color ?? ''"
            :placeholder="DEFAULT_COLOR_HEX"
            @change="onHexChange('stroke', $event)"
          >
          <label class="props-field props-stroke-w">
            <input type="number" min="0" :value="el.strokeWidth" @change="onNumericFieldChange('strokeWidth', $event)">
          </label>
        </div>
      </section>

      <section
        v-if="el.kind === ElementKind.Rect || el.kind === ElementKind.Frame"
        class="props-section"
      >
        <div class="props-section-title">Appearance</div>
        <label class="props-field">
          <span class="props-label">Corner radius</span>
          <input type="number" min="0" :value="el.cornerRadius ?? 0" @change="onNumericFieldChange('cornerRadius', $event)">
        </label>
      </section>

      <section v-if="el.kind === ElementKind.Text" class="props-section">
        <div class="props-section-title">Typography</div>
        <div class="props-stack">
          <select class="props-select" :value="el.fontFamily ?? ELEMENT_DEFAULT_FONT_FAMILY" @change="onFontFamilyChange($event)">
            <option v-for="family in FONT_FAMILY_OPTIONS" :key="family" :value="family">{{ family }}</option>
          </select>

          <div class="props-grid-2">
            <select class="props-select" :value="String(el.fontWeight ?? ELEMENT_DEFAULT_FONT_WEIGHT)" @change="onFontWeightChange($event)">
              <option v-for="weight in FONT_WEIGHT_OPTIONS" :key="weight.value" :value="weight.value">{{ weight.label }}</option>
            </select>
            <label class="props-field">
              <span class="props-label">Size</span>
              <input type="number" min="1" :value="el.fontSize ?? ELEMENT_DEFAULT_FONT_SIZE" @change="onNumericFieldChange('fontSize', $event)">
            </label>
          </div>

          <div class="props-grid-2">
            <label class="props-field">
              <span class="props-label">Line height</span>
              <input type="number" min="0.5" step="0.1" :value="el.lineHeight ?? ELEMENT_DEFAULT_LINE_HEIGHT" @change="onNumericFieldChange('lineHeight', $event)">
            </label>
            <label class="props-field">
              <span class="props-label">Letter spacing</span>
              <input type="number" min="0" step="0.1" :value="el.letterSpacing ?? ELEMENT_DEFAULT_LETTER_SPACING" @change="onNumericFieldChange('letterSpacing', $event)">
              <span class="props-unit">px</span>
            </label>
          </div>

          <div class="props-subtitle">Alignment</div>
          <div class="props-segmented">
            <button
              v-for="option in TEXT_ALIGN_OPTIONS"
              :key="option.value"
              type="button"
              class="props-segmented__btn"
              :class="{ 'is-active': (el.textAlign ?? ELEMENT_DEFAULT_TEXT_ALIGN) === option.value }"
              @click="setTextAlign(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <div v-else class="props-empty">{{ EMPTY_SELECTION_MESSAGE }}</div>
  </div>
</template>

<style src="./PropertiesPanel.scss" lang="scss" />
