# 一脉 · 极简 UI 原型方案（cut 2026-11-06）

> 绑定 cut：2026-11-06（APPROVED）。解锁顺序：**AC-1 → AC-2 → AC-3 → AC-4**；AC-4 未 PASS 前不做视觉抛光。  
> 线框文件：`/workspace/yimai-wireframes/tree-empty.svg` · `tree-populated.svg` · `person-sheet.svg`  
> 交接副本：`/workspace/ui-design/yimai-ui-handoff-2026-11-06.md`

---

## 0. 范围与假设

### In（本 cut 必须交付）
- 成员 CRUD：姓名、性别、世代、生年、卒年（卒年可空 = 在世）
- 父母绑定：每位成员最多一位父亲、一位母亲（可只填一侧）
- 配偶绑定：双向配偶关系（一人可有多段配偶史；MVP 不强制「现配偶唯一」；本 cut UI **不录入**结婚年/结束年/备注）
- 树状可视化：以前端**当前选中成员**为根，消费 `GET /persons/{id}/tree`，用 D3 或 OrgChart 渲染；前后端同一数据源
- 单用户、单树（最小鉴权由工程侧保障，本 UI 不暴露多树切换）

### Out（明确不做；出现即超 scope）
- 多树 / 多家族、邀请协作、权限角色
- 上传照片、附件、墓志铭长文
- 「叔舅姑姨」等复杂亲属称谓引擎 / 自动推导图
- 导入 / 导出 GEDCOM、Excel 批量
- 时间轴动画、打印排版、移动端专版
- 搜索 / 筛选高级面板、评论、审计日志
- OAuth 社交登录、支付、多租户 SaaS

### 平台与视觉
- **Platform：** desktop-first（树需要横向空间），建议最小宽度 **1024px**；移动端非本 cut
- **Visual tone：** 极简、中性、少装饰；节点卡片信息密度优先于插画；AC-4 PASS 前禁止视觉抛光

### 数据假设（本原型锁定）
- 单用户单树；无多树切换 UI
- **树根 = 当前选中成员**（`rootId = selectedPersonId`）。首次进入且树非空时：默认选中该树「创建的第一人」或列表首条（由 `GET /persons` 约定排序给出），**不是**「最早世代」启发式猜测
- 本 cut **不做**「我」标记实体 / 徽章；若后续要做，须新 cut
- 前端**不得**另起一套亲子/配偶推导算法；构图只信 `/persons/{id}/tree`

---

## 1. 信息架构 / 页面清单

仅以下三个表面（无底部 Tab、无第三套独立详情页）：

| # | 表面 | 一句话职责 |
|---|------|------------|
| 1 | **树浏览 Tree** | 主入口，全屏消费 tree JSON 构图；点节点打开 sheet |
| 2 | **成员表单 Person sheet** | 新建 / 查看 / 编辑同一表单（右侧 drawer/sheet） |
| 3 | **关系选择 RelPicker** | 模态或 sheet 内嵌步骤：选父母 / 选配偶（现有成员列表 + 「新建并绑定」） |

**导航**
- 顶栏：左「一脉」；右主按钮「添加成员」
- 点节点 → 打开 Person sheet（编辑态）
- 「添加成员」→ 打开 Person sheet（新建态）
- 关系绑定仅从 sheet 内「绑定父母 / 绑定配偶」进入 RelPicker
- 无底部 Tab；无独立关系管理页

---

## 2. 关键布局（文字线框 + 指向 SVG）

### 共用组件清单（尚无设计系统；本 cut 原语）

| 原语 | 复用 / 新建 | 说明 |
|------|-------------|------|
| TopBar | 新建 | 高 56；左标题，右 primary CTA |
| TreeCanvas | 新建 | pan/zoom 画布，承载 D3/OrgChart |
| PersonNode | 新建 | 姓名 + 性别字形 + 世代徽章 |
| EmptyState | 新建 | 无插画；标题 / 正文 / CTA |
| Sheet | 新建 | 右侧 400–440 宽；遮罩可点关闭（有未保存变更时先确认） |
| Field / Select | 新建 | 标签 + 控件 + 错误文案 |
| Button | 新建 | primary / ghost / danger |
| Chip | 新建 | 关系 chip，含 × 解绑 |
| Toast | 新建 | 短确认（已添加 / 已保存 / 已删除） |
| Dialog | 新建 | 删除确认、未保存离开确认 |
| RelPicker | 新建 | 搜索列表 + 确认 + 「新建并绑定」 |

**布局约定（全局）**
- 方向：顶栏横向；主区纵向 fill；Sheet 自右滑入
- 间距：页面边距 16–24；控件纵向 gap 12；区块 gap 24
- 节点：hug 内容；画布 fill 剩余视口

---

### 2.1 Tree

**SVG：** [`yimai-wireframes/tree-empty.svg`](./yimai-wireframes/tree-empty.svg) · [`yimai-wireframes/tree-populated.svg`](./yimai-wireframes/tree-populated.svg)

```
┌──────────────────────────────────────────────────────────────┐
│ 一脉                                      [ 添加成员 ]       │  ← TopBar 56
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                    TreeCanvas (fill)                         │
│         pan / zoom · 点击节点打开 Person sheet               │
│                                                              │
│   [空态居中] 或  [PersonNode…] —spouse— [PersonNode…]        │
│                         │ parent                             │
│                    [PersonNode…]                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**分层说明**
- TopBar：左产品名；右 primary「添加成员」
- Canvas：100% 剩余高度；背景中性浅灰；支持拖拽平移与滚轮/手势缩放
- PersonNode：姓名（主）+ 性别字形（♂/♀/·）+ 世代徽章（如「2」）；选中态描边加粗
- 配偶：以 spouse 边连接的双节点（或紧邻成对）；亲子：parent 边 `from=父母 → to=子女`
- 长名：节点内截断 + hover tooltip 全名
- Empty：见 §3 AC-4

---

### 2.2 Person sheet

**SVG：** [`yimai-wireframes/person-sheet.svg`](./yimai-wireframes/person-sheet.svg)

```
┌────────────────────────────┐
│ 新建成员 / 编辑·{姓名}  [×] │
├────────────────────────────┤
│ 姓名 *          [________] │
│ 性别            [男▼女/未知]│
│ 世代            [  2     ] │
│ 生年            [ 1990   ] │
│ 卒年            [  空=在世] │
│                            │
│ 父母                       │
│  [父 · 张三 ×] [绑定父母]  │
│  [母 · 李四 ×]             │
│  或：「尚未绑定父母」      │
│                            │
│ 配偶                       │
│  [王五 ×] [赵六 ×]         │
│  [绑定配偶]                │
│  或：「尚未绑定配偶」      │
├────────────────────────────┤
│ [删除]        [取消][保存] │
└────────────────────────────┘
```

**分层说明**
- 宽 400–440，高 100vh；从右滑入；左侧半透明遮罩
- Header：标题随模式切换；关闭按钮
- Fields：姓名 required；性别 `male|female|unknown`；世代整数 ≥1（与 PRD 根代=1 对齐）；生年可选；卒年可选（空=在世）
- Relations：父母区最多展示父 / 母各一 chip；配偶区 0..n chips（本 cut 不展示婚年）
- Footer：删除（仅编辑态、danger、二次确认）| 取消 | 保存（primary）

---

### 2.3 RelPicker

（嵌在 Sheet 之上的模态，或 Sheet 内第二步；无独立路由）

```
┌────────────────────────────┐
│ 选择父亲 / 母亲 / 配偶  [×]│
│ [搜索姓名 _____________]   │
│ ┌────────────────────────┐ │
│ │ 张三  · 男 · 第1代     │ │
│ │ 李四  · 女 · 第1代     │ │
│ │ …                      │ │
│ └────────────────────────┘ │
│ [新建并绑定]        [确认] │
└────────────────────────────┘
```

**分层说明**
- 列表来自 `GET /persons`；排除 self；父母场景再排除已占另一侧的非法候选若 UI 可知，否则以 API 4xx 为准
- 「新建并绑定」：打开嵌套的空 Person sheet（或同 sheet 切到新建），保存成功后自动完成绑定并返回
- 确认后关闭 RelPicker，回到 Person sheet，chip 更新

---

## 3. 关键交互与空态（对齐官方 AC-1～AC-4）

解锁顺序：**AC-1 → AC-2 → AC-3 → AC-4**。AC-4 未 PASS 前不做视觉抛光。

### AC-1 成员录入

**官方：** Proof = screenshot + API JSON（POST/GET person）。QA：能创建并回读姓名/性别/世代/生卒；缺姓名 → 422。

| 动作 | 交互 |
|------|------|
| Create | TopBar「添加成员」→ 空 Person sheet → 填字段 →「保存」→ `POST /persons` → 成功 toast「已添加」→ 关闭 sheet → 选中新成员为根并刷新树 |
| Read | 点击节点 → `GET /persons/{id}`（或用树上已有 node 字段预填，再按需拉详情）→ sheet 只读可编辑 |
| Update | 改字段 →「保存」→ `PATCH /persons/{id}` → 节点标签即时刷新 → toast「已保存」 |
| Delete | 「删除」→ Dialog：「删除后不可恢复。若仍有子女指向该成员将无法删除（须先解绑）。相关父母/配偶绑定会按服务端规则解除。」→ 确认 → `DELETE /persons/{id}`；409 时 inline/toast 提示先解绑子女；成功则移出节点与边 |
| Validation（客户端先行，服务端为准） | 姓名必填；卒年若有且生年有则卒年 ≥ 生年；世代整数 ≥ 1；缺姓名提交后展示服务端 422 |
| 空字段展示 | placeholder / 只读态显示「未填写」；卒年空 = 在世（不显示「未填写」文案，可显示「在世」） |

### AC-2 父母绑定

**官方：** Proof = API JSON + screenshot（树上可见亲子边）。QA：`PATCH` `father_id` / `mother_id` 后构图出现 parent 边；自指或环 → 4xx。**UI：父母各至多一侧（一位父、一位母）。**

| 动作 | 交互 |
|------|------|
| Bind | sheet「绑定父母」→ RelPicker 先选角色（父/母）或两个入口「绑定父亲」「绑定母亲」→ 选人 → 确认 → `PATCH /persons/{id}` 写入 `father_id` 或 `mother_id` |
| 上限 | 父、母各最多 1；已有则 RelPicker 为「更换」语义，或先 × 解绑再绑 |
| Unbind | chip × → `PATCH` 对应字段为 `null` → chip 消失 |
| Empty | 「尚未绑定父母」+「绑定父亲」「绑定母亲」按钮 |
| Error | 自指 / 环 / 非法 → 保持 RelPicker 打开，inline 展示 API 错误，不静默关闭 |
| 树上验证 | 绑定成功后以当前选中根重新 `GET /persons/{rootId}/tree`，应出现 `type=parent` 边 |

### AC-3 配偶绑定

**官方：** Proof = API JSON + screenshot。QA：`POST` spouse-link 后双方以 spouse 边相连；自配偶 → 422。

| 动作 | 交互 |
|------|------|
| Bind | sheet「绑定配偶」→ RelPicker → 选人 → 确认 → `POST /spouse-links`（`person_a_id` / `person_b_id`） |
| 多段 | MVP 允许 0..n 配偶 chips（不做婚姻日期录入；PRD 中 start/end/note 本 cut UI 不暴露） |
| Unbind | chip × → `DELETE /spouse-links/{id}`（需持有 link_id；可来自详情或 tree edges） |
| Empty | 「尚未绑定配偶」+「绑定配偶」 |
| Error | 自配偶等 → 422 inline，不关闭 picker |
| 树上验证 | 刷新 tree JSON，应出现 `type=spouse` 边 |

### AC-4 树可视化前后端一致

**官方：** Proof = screenshot + 同 root 的 tree JSON。QA：节点数 / 亲子边 / 配偶边与 JSON 一致（≥3 代 fixture）。前端**只**消费 `/persons/{id}/tree`，**不得**另起关系算法。

| 状态 | 交互 |
|------|------|
| Load | 以**当前选中成员**为 `rootId` → `GET /persons/{rootId}/tree` → Canvas loading skeleton |
| Render | D3 或 OrgChart 按返回的 `nodes` + `edges` 构图；root 高亮 |
| 选中 | 点击节点 → 设为 selected → 打开 sheet；可选：同时将该节点设为新 root 并重拉 tree（推荐 MVP：打开 sheet 不强制换根；提供「以此为根」次要操作或双击换根——**默认实现：单击打开 sheet；工具条或节点菜单「设为根」才换 root**） |
| Pan / zoom | 支持；不截断交互 |
| Empty（0 persons） | 无插画 EmptyState：标题「还没有家族成员」；正文「添加第一位成员开始这棵树」；CTA「添加成员」 |
| Error | 「树加载失败」+「重试」 |
| Long tree | canvas pan/scroll；长名 tooltip |
| Consistency | QA 用 ≥3 代 fixture：图上节点数、parent 边数、spouse 边数与同 root JSON 一致 |

**权威 tree JSON 形状（字段名 Eng 可微调，语义锁定）：**

```json
{
  "root_id": "…",
  "nodes": [
    {
      "id": "…",
      "name": "…",
      "gender": "male|female|unknown",
      "generation": 1,
      "birth_year": 1990,
      "death_year": null
    }
  ],
  "edges": [
    { "type": "parent", "from": "parent_id", "to": "child_id" },
    { "type": "spouse", "a": "…", "b": "…", "link_id": "…" }
  ]
}
```

---

## 4. 状态总表

| Surface | empty | loading | error | populated | long-content |
|---------|-------|---------|-------|-----------|--------------|
| Tree | 「还没有家族成员」+ CTA | Canvas skeleton | 「树加载失败」+ 重试 | 节点+边；选中高亮 | pan/zoom；tooltip 全名 |
| Person sheet | 新建：空字段+placeholder | 编辑：字段 skeleton | 加载失败文案+关闭 | 字段填满；关系 chips | 表单区内部滚动；footer 固定 |
| RelPicker | 「无匹配成员」+「新建并绑定」 | 列表 skeleton | inline API 错误 | 可搜索列表 | 列表虚拟滚动（可选；≥50 人再做） |
| Toast / Dialog | — | — | 409/422 说明 | 成功短提示 | — |

---

## 5. 给工程的接口 / 组件约定（短）

### 5.1 前端消费（锁定）
- **Tree 数据唯一来源：** `GET /persons/{id}/tree`
- **Root 规则：** `id` = 当前 UI 选中并「设为根」的成员；首次默认 = 人员列表首条（创建的第一人），**不是**最早世代猜测
- **渲染：** D3 或 OrgChart；禁止前端自行推算亲子/配偶

### 5.2 Tree 组件 props（约定）
```
TreeCanvasProps {
  data: { root_id, nodes[], edges[] }  // 权威形状见 §3 AC-4
  selectedId?: string
  onNodeClick(id): void
  onSetRoot(id): void
  status: 'empty' | 'loading' | 'error' | 'ready'
  onRetry(): void
}
```
- `PersonNode` click → `onNodeClick` → 打开 Person sheet
- parent 边：`from` → `to`；spouse 边：`a`—`b`（可用 `link_id` 解绑）

### 5.3 变更类 API（与 PRD 对齐；UI 按此接线）
| 用途 | 方法 / 路径 |
|------|-------------|
| 列表 | `GET /persons` |
| 创建 | `POST /persons` |
| 详情 | `GET /persons/{id}` |
| 更新字段 / 父母 | `PATCH /persons/{id}`（含 `father_id` / `mother_id`，可 null） |
| 删除 | `DELETE /persons/{id}`（有子女 → 409） |
| 构图 | `GET /persons/{id}/tree` |
| 配偶列表 | `GET /spouse-links` |
| 绑定配偶 | `POST /spouse-links` |
| 更新配偶（本 cut UI 不用） | `PATCH /spouse-links/{id}` |
| 解除配偶 | `DELETE /spouse-links/{id}` |
| 当前树元数据 | `GET /trees/current` |

前缀假设 `/api/v1`；均需认证；只操作当前用户的树。

### 5.4 开放给 SWE 确认（勿在 UI 再发明路径）
1. `GET /persons` 默认排序是否保证「创建的第一人」在首？
2. 单击节点是否隐含换根，还是必须显式「设为根」？（本方案推荐显式）
3. spouse `link_id` 是否保证出现在 tree `edges` 中以便 UI 解绑？
4. 父母「更换」是直接 PATCH 覆盖还是必须先 null？
5. 409/422 错误体字段名（便于 inline 展示）

---

## 6. 开放问题（最多 5 条，供 Boss / SWE 拍板）

1. **Root 交互：** 单击节点仅打开 sheet，还是同时换根重拉 tree？本方案默认「单击打开 sheet + 显式设为根」。
2. **「我」标记：** 本 cut 明确不做；是否列入下一 cut？
3. **父母上限：** 已按官方锁定为父/母各至多 1；UI 是否区分「绑定父亲 / 绑定母亲」两个入口？（推荐是）
4. **配偶 0..n：** 已按 PRD 允许多段；UI 本 cut 是否完全隐藏 start/end/note？（推荐隐藏）
5. **tree JSON：** 以上形状为权威语义；字段命名若 Eng 微调，需在 AC-4 fixture 前书面确认一版。

---

## 7. 非本 cut（明确不做）

- 多树 / 多家族、邀请协作、权限角色
- 上传照片、附件、墓志铭长文
- 复杂亲属称谓引擎 / 叔舅姑姨推导图
- 导入 / 导出 GEDCOM、Excel 批量
- 时间轴动画、打印排版、移动端专版
- 搜索 / 筛选高级面板、评论、审计日志
- OAuth 社交登录、支付、多租户 SaaS
- AC-4 未 PASS 前的视觉抛光、插画、品牌动效
- 「我」标记、婚姻起止年录入（UI）

---

## 附录 · 文件清单

| 路径 | 说明 |
|------|------|
| `/workspace/yimai-ui-prototype-2026-11-06.md` | 本方案 |
| `/workspace/yimai-wireframes/tree-empty.svg` | Tree 空态线框 1280×800 |
| `/workspace/yimai-wireframes/tree-populated.svg` | Tree 有数据线框 1280×800 |
| `/workspace/yimai-wireframes/person-sheet.svg` | Person sheet + 树背景线框 1280×800 |
| `/workspace/ui-design/yimai-ui-handoff-2026-11-06.md` | 短交接说明 |
