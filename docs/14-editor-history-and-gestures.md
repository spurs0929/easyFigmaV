# Editor State, Undo / Redo and Gesture Lifecycle

對照版本：`main @ 46a24fe`。本文描述已實作的行為與設計理由；未實作的部分
集中在「已知限制」。

## 範圍

這份文件處理 editor 端的三件事：

- 元素樹如何保存，以及為什麼 store 物件必須不可變。
- Undo / Redo 的 snapshot 設計，與「一次操作 = 一筆 History」的規則。
- 滑鼠手勢（拖曳、縮放、繪製、Pen）的生命週期，以及手勢期間如何保護文件。

相關程式碼：

| 檔案                                   | 職責                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| `src/store/element.ts`                 | 元素樹、選取、History、`documentRevision`、checkpoint   |
| `src/composables/useCanvasActions.ts`  | 刪除、群組、解散群組、複製                              |
| `src/composables/useCanvasKeyboard.ts` | 快捷鍵表與手勢期間的守衛                                |
| `src/components/canvas/CanvasArea.vue` | Konva Stage、手勢狀態機、漏接 mouseup 的收尾            |
| `src/types/canvas.ts`                  | `GestureState`                                          |
| `src/types/element.ts`                 | 元素型別、`ELEMENT_HISTORY_MAX`、`assertStoreIntegrity` |

## 元素資料模型

```ts
interface ElementStore {
  byId: Readonly<Record<string, CanvasElement>>
  rootIds: string[] // index 0 = 最底層
}
```

- `byId` 提供 O(1) 查找；`rootIds` 保存根層的圖層順序。
- 群組以 `childIds` 保存子元素順序，子元素以 `parentId` 指回群組；子元素
  座標相對於群組原點。
- 每次變更都建立新的 store 物件，只替換受影響的元素，沒動到的元素沿用同一個
  物件。舊的 store 物件（也就是 History 裡的快照）永遠不被原地修改。
- 結構性操作結束時呼叫 `assertStoreIntegrity()`，在開發環境驗證
  `byId`、`rootIds`、`parentId`、`childIds` 一致。

不可變是整個 History 設計的前提：快照只是保存舊 store 物件的參考，不需要深拷貝；
「有沒有變更」也能用參考判斷。

## Snapshot-based History

```text
_history:      [S0, S1, S2, S3]
_historyIndex:              ↑
```

- `_pushSnapshot()` 截掉目前位置之後的 Redo，再推入目前的 store 物件。
- 上限 `ELEMENT_HISTORY_MAX = 50` 是**狀態數**，包含基準狀態，所以最多
  Undo 49 步。超過時丟掉最舊的一筆。
- `undo()` / `redo()` 只移動位置、把 store 換成那一筆，並清除選取、遞增
  `documentRevision`。
- History 只存在記憶體，不進 IndexedDB、不進雲端，也不跨分頁。

### 為什麼用 snapshot，不用 command pattern

Command pattern 要求每一種操作都寫出正確的 inverse。群組 / 解散群組牽涉座標
轉換、圖層位置與巢狀結構，inverse 寫錯就會悄悄破壞文件，而且很難測全。

Snapshot 只要求「變更不可變」，Undo 就是換回舊物件，正確性不依賴每個操作的
實作細節。代價是記憶體，但因為沒變的元素共用物件，每筆快照實際只多出被改到的
那幾個元素與外層容器。

### 參考去重，不做深度比較

`_pushSnapshot()` 在推入前比較目前 store 與 History 目前那一筆是否為同一個
物件（比較前先 `toRaw()`，避免 reactive proxy 與原始物件被當成不同）。同一個
物件代表什麼都沒改，不推、也不截斷 Redo。

這擋得住「純點擊」「點了縮放把手沒拖」這類完全沒呼叫寫入的情況，但擋不住
「內容相同、參考不同」。後者由各操作自己負責，例如：

- `_reorder()` 順序沒有實際改變時提前返回，不建立新物件。
- `removeMany()`、`ungroupMany()` 沒有有效目標時提前返回。

刻意不做整份文件的深度比較：成本隨文件大小成長，每次提交都要付；而且把
「無變更」的判斷集中在一個通用比較裡，會掩蓋個別操作本來就該提前返回的責任。

## 一次使用者操作 = 一筆 History

使用者認知中的一次操作是一個 transaction：內部可以有多次 store mutation，但
History、`documentRevision` 的提交邊界與 autosave 排程應該對應到一次。

| 操作                          | 實作                                                 | History                          |
| ----------------------------- | ---------------------------------------------------- | -------------------------------- |
| 多選刪除                      | `deleteSelected()` → 一次 `removeMany(ids)`          | 1 筆；祖先與子孫同時選取不重複刪 |
| 建立群組                      | `group(ids)`，至少兩個根層元素                       | 1 筆                             |
| 多選解散群組                  | `ungroupSelected()` → 一次 `ungroupMany(ids)`        | 1 筆                             |
| 複製                          | 蒐集複本後一次 `addAll()`                            | 1 筆                             |
| 圖層順序（`[` `]`、右鍵選單） | 迴圈呼叫 `_reorder()`，最後 `pushSnapshot()` 一次    | 1 筆；無變更時 0 筆              |
| 拖曳、縮放                    | 過程 `update()`，放開時提交                          | 1 筆；回到原狀時 0 筆            |
| 屬性面板                      | `change` 事件才 `commitUpdate()`                     | 每次確認 1 筆                    |
| 色彩選擇器                    | 預覽用 `update()`，關閉時顏色有變才 `pushSnapshot()` | 1 筆                             |
| 文字編輯                      | 文字有變才 `update()` + `pushSnapshot()`             | 1 筆（新增文字見已知限制）       |

`ungroupMany()` 是這個原則的典型做法：在同一份工作副本（`byId`、`rootIds`
的淺拷貝）上依序套用每個群組的轉換，最後才寫入 store 一次、推快照一次、遞增
revision 一次。`ungroup(id)` 委派給 `ungroupMany([id])`，避免兩份實作分歧。

選取變化不屬於文件，不產生 History。

## 高頻更新與手勢的提交邊界

拖曳與縮放在每次 mousemove 呼叫 `update()`：只換 store 物件、遞增
`documentRevision`，不推快照。放開時才提交一次。

### 回到原狀

拖出去再拖回原位時，內容與按下時相同，但 store 已經是新物件，參考去重擋不住，
會多推一筆空白 History 並清掉 Redo。

只是「放開時不推」也不夠：store 的參考會與 History 目前那一筆不一致，之後的
任何一次 `pushSnapshot()`（例如一次純點擊）都會把這個「內容沒變的新物件」推進去，
等於把空白 History 延後產生。

因此手勢開始時記下 checkpoint，放開時先嘗試換回：

```text
mousedown  → checkpoint = elementStore.checkpoint()
mousemove  → update() ...
mouseup    → restoreIfUnchanged(checkpoint)   // 內容相同就換回原物件
           → pushSnapshot()                   // 參考相同，被去重擋下
```

`restoreIfUnchanged()` 的比較是淺層的：

- 沒被改過的元素，`update()` 沿用同一個物件，只比參考。
- 參考不同的元素逐一比較自身屬性，屬性值也只比參考，不往下展開。
- `rootIds` 參考不同時逐項比較順序。

只要有一處不同就判定為已變更。這可能把「內容其實相同」判成已變更（結果只是
多一筆 History，與修正前相同），但不會把真的有變更的狀態換掉。

Checkpoint 另外記下 History 的世代。`loadSnapshot()` 重設 History 時世代遞增，
重設前記下的 checkpoint 一律失效，不會把舊文件物件換回新的 History 裡。

`restoreIfUnchanged()` 本身不遞增 `documentRevision`，但手勢過程的 `update()`
已經遞增過，所以拖回原位**仍可能排程一次 autosave**（存的內容與原本相同）。
這個修正保證的是 History 與 Redo 的語意，不是避免存檔。

## 三種「版本」的分工

| 機制               | 用途                                     | 範圍             |
| ------------------ | ---------------------------------------- | ---------------- |
| 元素 History       | 本機 Undo / Redo                         | 記憶體，單一分頁 |
| `documentRevision` | 通知「文件內容變了」，觸發 autosave 排程 | 前端狀態         |
| `document_version` | 雲端存檔的 optimistic locking            | PostgreSQL       |

Undo 是把本機 store 換回舊物件，不是資料庫回滾；Undo 之後的狀態一樣會被
autosave 當成新內容存出去。History 也不是多人同步的 operation log（見
[v1 Architecture](13-v1-architecture.md)）。

## 手勢期間的快捷鍵守衛

不變條件：**手勢不是 idle 時，不允許另一條快捷鍵路徑修改文件。**

`useCanvasKeyboard.ts` 的快捷鍵表每一項都必須標明 `modifiesDocument`：

- 會改文件（手勢中忽略）：Delete、Backspace、Ctrl+Z、Ctrl+Y、
  Ctrl+Shift+Z、Ctrl+D、Ctrl+G、Ctrl+Shift+G、`]`、`[`。
- 不改文件（照常可用）：Ctrl+A。
- 已註冊的快捷鍵一律 `preventDefault()`，包括被忽略的時候，避免落到瀏覽器
  預設行為。
- 焦點在輸入框、textarea 時整張表都不處理，交給原生編輯行為。

違反這個條件的實際後果：

- 拖曳中 Ctrl+Z：store 換回舊快照，放開時又把拖曳中的座標推上去，Undo 等於
  遺失了一段 History。
- 拖曳中 Ctrl+G：群組把子元素座標轉成相對座標，下一次 mousemove 又用絕對座標
  寫回，子元素被搬到錯誤位置，並被 autosave 存下。

### 為什麼忽略，而不是先結束手勢再執行

先結束手勢會在使用者還按著滑鼠時替他「放開」，下一次 mousemove 的歸屬變得
不明確；而在手勢中途改文件，正是上面兩個問題的根源。忽略最單純，也與 Pen 的
規則一致。

### Pen

Pen 是跨多次點擊的手勢，兩次點擊之間（草稿）也算手勢，以上文件命令都會被忽略。
Pen 自己處理幾個按鍵：Escape 取消、Enter 完成、Backspace / Delete 刪掉最後
一個錨點。Ctrl+Z 不會退回上一個錨點，Pen 草稿不進 History。

## 漏接 mouseup 的手勢收尾

Konva 的滑鼠事件只綁在 Stage 的 content 元素上。在畫布外放開時 Stage 收不到
mouseup，手勢會卡在進行中，之後的快捷鍵守衛也會一直擋住 Undo。

`_pressButton` 記下開始按壓的是哪一顆鍵（只處理左鍵、中鍵），另一顆鍵放開
不會誤結束手勢。收尾只在**偵測到原按鍵已放開**時發生：

1. window 的 capture 階段 `mouseup`：
   - target 在 Stage 外 → 直接收尾。
   - target 在 Stage 內 → 延後一個 macrotask 確認；Stage 若已自己處理就不再
     動作，若事件被其他 listener 攔下、Stage 沒收到，才由這裡收尾。
2. 回到畫布的 `mousemove`：`evt.buttons` 已不含原按鍵 → 收尾。
3. 下一次 `mousedown`：上一次按壓還沒結束時，若按下的是同一顆鍵，或原按鍵已
   不在 `evt.buttons` → 先收尾，再開始新的按壓；若原按鍵仍按著（例如左鍵拖曳中
   按下中鍵）→ 忽略這次按下，不覆蓋進行中的手勢。

補救路徑呼叫 `onMouseUp(false)`，以**畫面上最後呈現的狀態**完成手勢，不讀
`stage.getPointerPosition()`（那是離開畫布前的位置，不是放開的位置）：

| 手勢        | 畫布上放開             | 漏接時                             |
| ----------- | ---------------------- | ---------------------------------- |
| 平移        | 結束                   | 結束，還原游標                     |
| 拖曳、縮放  | 提交一筆               | 停在最後一次畫布上的位置，提交一筆 |
| 框選        | 依框選取               | 依最後的框選取                     |
| 繪製        | 用放開點建立元素       | 用預覽最後的點建立                 |
| Pencil      | 補上放開點後完成       | 不補點，直接完成                   |
| Pen（按著） | 結束這次按壓，草稿保留 | 同左                               |

### 為什麼是收尾，而不是取消

使用者放開時看到的就是最後的狀態；取消會讓已經看到的結果消失，而且在拖曳、
縮放上等於靜默丟掉一次操作。

### 為什麼不用 window blur

單純切換視窗或焦點離開，不代表使用者放開了滑鼠。畫布手勢刻意沒有任何
`blur` / `visibilitychange` listener（這兩個事件只用在 autosave flush），
避免切換視窗就結束手勢。

## History 何時重設

`loadSnapshot()` 以載入的內容建立新的單一基準狀態，清空 Undo / Redo 與選取。
以下情況都會走到它：

- 開啟本機草稿或雲端專案。
- 存檔衝突（409）後 `reloadFromBackend()` 重新載入。
- 離開雲端專案時清空畫布。

這是刻意的：History 裡的快照屬於載入前那份文件，跨過載入之後 Undo 會把別的
版本的內容帶回來。

## 設計取捨

| 決策                        | 沒採用的做法     | 理由                               |
| --------------------------- | ---------------- | ---------------------------------- |
| Snapshot History            | Command pattern  | 正確性不依賴每個操作的 inverse     |
| 參考去重 + 操作自行提前返回 | 整份深度比較     | 成本不隨文件成長，責任留在操作本身 |
| 手勢期間忽略文件命令        | 先結束手勢再執行 | 不在使用者按著滑鼠時替他放開       |
| 漏接 mouseup 時收尾         | 取消手勢         | 保留使用者已看到的結果             |
| 偵測按鍵放開才收尾          | window blur 收尾 | 切換視窗不等於放開                 |
| 淺層 `restoreIfUnchanged`   | 只比 x / y       | 不漏掉尺寸、圖層或其他元素的變更   |
| `loadSnapshot` 重設 History | 跨載入保留       | 舊快照屬於另一份文件               |

## 已知限制

History 相關：

- 新增文字會產生兩筆 History（建立空的 Text、確認文字各一筆）；文字留空會被
  刪除，之後 Undo 會讓空的 Text 重新出現。修正需要調整文字編輯的生命週期。
- 屬性面板填入與目前相同的值仍會多一筆 History。
- 色彩選擇器預覽後改回原本的顏色再關閉：不推 History，但 store 已是新物件，
  之後下一次 `pushSnapshot()` 可能多一筆空白 History。
- Undo / Redo 會清除選取。
- Pen 草稿期間 Undo 與其他文件命令被忽略，目前沒有畫面提示。

非 History，但與文件正確性相關：

- Ctrl+D 複製巢狀群組時只為直接子元素建立新 id；子群組的複本仍指向原本的
  孫元素，兩邊共用，刪除複本會一併刪掉原群組的內容。在圖層面板選取群組內的
  子元素按 Ctrl+D，會產生孤兒節點。
- 文件載入只驗證欄位型別，不驗證樹狀結構（循環參照、父子不一致、同一個 child
  掛在多個 parent）；不合法的文件載入後，刪除操作可能堆疊溢位。
- 元件卸載時不替進行中的手勢收尾（只會在按住滑鼠時離開頁面發生，下次載入時
  History 本來就會重設）。
- 右鍵選單的操作不經過快捷鍵守衛；實務上點選選單需要左鍵，會先結束拖曳。

## 測試與維護原則

主要測試：

- `src/store/element.spec.ts`：History、去重、批次操作、checkpoint。
- `src/composables/useCanvasActions.spec.ts`：刪除、群組、解散群組的 History 筆數。
- `src/composables/useCanvasKeyboard.spec.ts`：每個快捷鍵 × 每種手勢的守衛。
- `src/components/canvas/CanvasArea.spec.ts`：以真實 DOM 事件經過 Konva 的手勢
  生命週期，包含畫布外放開、mouseup 被攔下、按鍵交錯、mousemove 收尾。

Undo 與手勢相關的修正（Batch 2、U3 系列）都先確認新測試在修正前的原始碼上
失敗，並以 mutation（逐一拿掉修正的各個部分）確認測試真的保護得到該行為。

新增會修改文件的功能時：

1. 在快捷鍵表標明 `modifiesDocument`。
2. 定義這次操作的 History 邊界：一次操作只推一次快照。
3. 沒有實際變更時提前返回，不建立新的 store 物件。
4. 不原地修改既有 store 物件與元素。
5. 測試涵蓋：History 筆數、Undo / Redo 往返、Redo 是否被誤清、手勢中按快捷鍵、
   漏接 mouseup，以及 `assertStoreIntegrity()`。
