# easyFigmaV

- 目前是一個以 Vue 3、Pinia、Konva、PrimeVue 為核心的 Figma-like 畫布編輯器。
- 畫面骨架已經成形，包含工具列、圖層面板、主畫布、屬性面板。
- 互動重點已放在畫布編輯、圖形建立、文字編輯、圖層操作與評論流程。

## 目前已實作的功能

### 1. 編輯器基本骨架

- 已完成四欄式編輯器版面：
  - Toolbar
  - Layer Panel
  - Canvas
  - Properties Panel
- 專案目前是單頁式編輯器，主要操作集中在同一個畫布畫面中。

### 2. 工具列與工具切換

- 已有工具群組與子工具下拉選單。
- 每個工具群組會記住最後一次使用的子工具。
- 已支援快捷鍵切換工具。
- `Space` 可暫時切換成 Hand 工具。
- 目前可看到並切換的主要工具包含：
  - Move
  - Region Select
  - Rectangle
  - Ellipse
  - Line
  - Polygon
  - Star
  - Frame
  - Pen
  - Pencil
  - Text
  - Comment
  - Hand

### 3. 畫布操作與視窗控制

- 已完成 Konva Stage 初始化。
- 已用 `ResizeObserver` 同步畫布容器尺寸。
- 已支援滑鼠拖移平移畫布。
- 已支援 `Ctrl/Cmd + 滾輪` 縮放畫布。
- 已支援一般滾輪平移。
- 已有縮放感知的背景格線。
- 格線顯示有 hysteresis 邏輯，避免在臨界縮放值來回閃爍。
- 已有 viewport culling，會只渲染可視範圍附近元素，降低重繪成本。

### 4. 元素建立與繪製

- 已可建立下列圖形元素：
  - Rectangle
  - Frame
  - Ellipse
  - Line
  - Polygon
  - Star
  - Text
- 已支援 Pen 工具建立向量路徑。
- Pen 已支援閉合路徑與 Bezier 控制點預覽。
- 已支援 Pencil 自由手繪，並轉成 Vector 元素。
- 文字元素可直接在畫布上建立，建立後會自動進入編輯狀態。

### 5. 選取、移動、框選與尺寸調整

- 已支援單選與多選。
- 已支援框選（marquee selection）。
- 已支援拖曳移動元素。
- 已支援單一選取元素的四角 resize。
- 已有選取外框與控制點顯示。
- 已有根節點選取邏輯，群組內子元素操作時會回到可操作的 root selection。

### 6. 圖層與結構管理

- 已有以 `byId + rootIds` 為核心的元素樹狀資料結構。
- 已支援群組與取消群組。
- Group 邊界會依子元素重新計算。
- 已支援圖層順序操作：
  - Bring to Front
  - Send to Back
  - Move Up
  - Move Down
- 已支援 Duplicate。
- 已支援 Delete。
- 已支援 Select All。
- Layer Panel 已支援：
  - 樹狀展開 / 收合
  - 選取
  - Shift 範圍選取
  - 右鍵操作入口

### 7. 屬性面板

- 目前針對「單一選取元素」提供屬性編輯。
- 已可調整：
  - X / Y
  - Width / Height
  - Rotation
  - Opacity
  - Fill
  - Stroke
  - Stroke Width
- Text 已支援 Typography 設定：
  - Font Family
  - Font Weight
  - Font Size
  - Line Height
  - Letter Spacing
  - Text Align

### 8. 文字編輯體驗

- 已支援雙擊文字進入編輯。
- 已用 overlay textarea 方式處理畫布上的文字輸入。
- 文字輸入時會同步字型、字重、大小、對齊等視覺樣式。
- 空白文字在提交時會自動刪除，避免留下空元素。

### 9. 評論功能

- 已支援 Comment 工具在畫布上放置 pin。
- Comment pin 可開啟 popover 編輯內容。
- 已支援評論文字更新。
- 已支援評論標記為 resolved / unresolved。
- 已支援刪除評論。
- 評論資料目前會寫入 `localStorage`，重新整理後仍可保留。

### 10. 快捷鍵與互動輔助

- 已支援常見快捷鍵：
  - `V` Move
  - `R` Rectangle
  - `O` Ellipse
  - `L` Line
  - `F` Frame
  - `P` Pen
  - `Shift + P` Pencil
  - `T` Text
  - `C` Comment
  - `H` Hand
  - `Delete / Backspace` 刪除
  - `Ctrl/Cmd + Z` Undo
  - `Ctrl/Cmd + Y` 或 `Ctrl/Cmd + Shift + Z` Redo
  - `Ctrl/Cmd + D` Duplicate
  - `Ctrl/Cmd + G` Group
  - `Ctrl/Cmd + Shift + G` Ungroup
  - `Ctrl/Cmd + A` Select All
  - `[` / `]` 調整圖層順序
- 已有拖曳尺寸標示與對齊輔助線。
- 已支援 `Alt + Hover` 顯示距離量測資訊。

### 11. Undo / Redo 與資料操作

- 元素編輯已具備 snapshot-based Undo / Redo。
- Store 內已有資料完整性檢查邏輯。
- 已對群組、刪除、複製、屬性更新等行為納入操作歷史。
