# 一脉 — Product PRD (living SoT)

> **PM review 节优先。** 顶节为 dated binding cuts。Eng 不得在 cut 获 APPROVED 前开 Cloud Agent。中途加范围须新 dated cut，禁止聊天漂移。

---

## Binding cut — 2026-11-11 delete-correction (APPROVED)

**Decision needed:** ~~approve single-person confirmed delete + specified relationship correction~~ → **APPROVED**（Boss via Master / user 2026-11-11；Cursor Auto only）。  
**Visual addendum（同日 15:49 Asia/Shanghai）：** 宣纸/墨/朱砂视觉收束 + 响应式 CSS 折行 **APPROVED**；与本 cut **同一工程 PR**，先 DEL 行为后视觉，再合并回归。不另开竞争分支。

**本 cut 并列于：** 同日 Explicit siblings cut（**不取代**兄弟姐妹 cut）。修订/例外：允许「删除确认 UI」与「父母/配偶/显式兄妹指定解除 UI」进入 In；其余 2026-11-06 Out 仍有效。

**一句话结果：** 用户能凭详情中的姓名与 **谱号** 确认后，只删除这一人（不级联整支）；也能对指定关系纠错（清空父母、解除指定夫妻或显式兄妹）；有子女时继续按原 AC-5 保护并指引解绑，不强迫删除真实子女或配偶。

### In
- 删除确认 UI：姓名 + 谱号 {id}；确认后只删该 id；取消无人/边变化
- 关系纠错 UI：清空指定父/母槽；`DELETE` 指定 spouse/sibling `link_id`
- 删后收尾：关详情 / 根与视角 / 空谱添加首人（DEL-6）
- 失败与未知：不假成功；按发出请求时原 id 核对后可安全重试（DEL-7）
- 有子女：409 + 中文原因 + 打开子女纠错；配偶不阻断
- 不新增 API 端点；沿用 `DELETE /persons/{id}`、`PATCH` 父母置空、`DELETE /spouse-links/{id}`、`DELETE /sibling-links/{id}`
- 视觉（同 PR）：token/对比/焦点/忙态 aria-busy/取消整页 min-width:760 的 CSS 折行；不改既有业务文案

### Out
- 级联删除家族、回收站、批量删除、养父母、排行重排、自动迁移、占位人、来源筛选 UI
- 把有配偶改成删人阻断；新云调用；独立全局换肤产品重做；合并/部署未授权

### Acceptance：DEL-1…DEL-7
见上传 binding cut 与 `docs/superpowers/specs/2026-11-11-delete-correction-design.md`。Proof：screenshot + API JSON。原 AC-5、AC-6、SIB-AC 与登录/加载/幂等/非传递/首人恢复不得削弱。QA 高风险 DEL-H-01…24 与 REG 清单为预言/夹具，不扩产品范围。视觉 VIS 与组件规格见 `docs/design/yimai-visual-component-spec-2026-11-11.md`。

### 工程约束摘要
- 谱号统一（新 DEL 控件不用冲突的「ID」标签）
- 204 成功不要求 JSON 解析；409 保留英文 `children` 消息供旧测，可附加 `children[]`
- 冻结确认时原 person/link/slot；禁止乐观假删；未知结果不得当成功
- FK `nullOnDelete` **不**等同严格 409；以应用层检查 + 事务复核评估安全
- 禁止写入原 Mac/demo 18 人谱；隔离夹具（新库 id=1 合法）

---

## Binding cut — 2026-11-11 Explicit siblings (APPROVED)

**Decision needed:** ~~approve explicit two-person sibling links independent of parents~~ → **APPROVED**（Boss via Master / user 2026-11-11；Cursor Auto only for eng）。

**本 cut 取代 / 修订：** 2026-11-06 中「构图 edges 仅 parent|spouse」的锁定，以及前端「添兄弟姐妹必须先有已知父母并复制 parent IDs」的过时限制（工程侧曾称 R3 / sibling-parent-copy gate）。共享父母仍是**独立**的派生证据，不再是记录兄弟姐妹的唯一路径。

**一句话结果：** 用户可在父母未知或不同时，为当前人显式记录对称的两人兄弟姐妹关系；图与双方详情可见；不伪造父母、不自动传播父母、不从 A–B 与 B–C 推断 A–C。

### In
- `SiblingLink`：同 tree 两人无向唯一边；API `/sibling-links`；tree JSON `type=sibling` 边（含 `link_id`）
- UI：哥/姐/弟/妹 入口可在父母为空时姓名新建或按具体 ID 选已有人；绑定写 sibling-link，**不**复制 `father_id`/`mother_id`
- 详情兄弟姐妹名单 = 派生（共享已知父母）∪ 显式边，按 person id 去重
- 删除成员时级联清理其 sibling-links；保留 AC-5 有子女 → 409

### Out（本 cut）
- 兄弟姐妹解绑管理 UI、兄弟组/传递闭包、过继/继父母模型、占位人、旧关系批量回填、复杂排版/称谓引擎、年龄长幼校验

### Acceptance：SIB-AC1…SIB-AC7
见 `docs/superpowers/specs/2026-11-11-explicit-siblings-design.md` §5。Proof：API JSON + 截图（按条）。

### 稳定契约摘要
- `POST /api/v1/sibling-links` `{ person_a_id, person_b_id }` → 规范序 `a < b`；已存在则 200，新建 201；自指 422
- Tree edge：`{ "type":"sibling", "a", "b", "link_id" }`
- 父母 PATCH 仍只改目标人；冲突槽位拒绝静默覆盖

---

## Binding cut — 2026-11-06 (APPROVED)

**Decision needed:** ~~approve | reject 任一 Out 项回 In | pick unlock order~~ → **APPROVED**（Boss via Master，默认 unlock order AC-1→AC-6）。

**本 cut 取代：** 无（首切）。

**一句话结果：** 登录用户能录入家族成员（姓名/性别/世代/生卒），绑定父母与配偶，并在前后端看到同一棵可读的树状分支图。

### 1. MVP In / Out

#### In（本 cut 必须交付）
- 成员 CRUD：姓名、性别、世代、生年、卒年（卒年可空=在世）
- 父母绑定：每位成员最多一位父亲、一位母亲（可只填一侧）
- 配偶绑定：双向配偶关系（一人可有多段配偶史；MVP 不强制「现配偶唯一」）
- 树状可视化：以选定成员为根（或默认第一代），展示上下代与配偶；前后端同一数据源
- 最小鉴权：能区分「当前用户的一棵树」；他人树不可读写（单用户/单树即可）

#### Out（明确不做；想加须新 cut）
- 多树/多家族、邀请协作、权限角色
- 上传照片、附件、墓志铭长文
- 姻亲以外的「叔舅姑姨」自动推导图、复杂亲属称谓引擎
- 导入/导出 GEDCOM、Excel 批量
- 时间轴动画、打印排版、移动端专版
- 搜索/筛选高级面板、评论、审计日志
- OAuth 社交登录、支付、多租户 SaaS

### 2. 完成定义

Boss 一次通过本 cut；下列 AC 全部 PASS 且附约定 Proof；Eng 未在 APPROVED 前开 Cloud Agent（本 cut 已 APPROVED）。QA 只按本 cut 验收，禁止 soft-pass。

### 3. 核心数据实体与字段

#### Person（成员）
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | UUID/bigint | 是 | 主键 |
| tree_id | FK | 是 | 所属家族树 |
| name | string(1–64) | 是 | 显示名 |
| gender | enum: male / female / unknown | 是 | 默认 unknown |
| generation | int (≥1) | 是 | 世代；根代=1 |
| birth_year | int? | 否 | 四位年；允许空 |
| death_year | int? | 否 | 空=在世；若有则 ≥ birth_year（有生年时） |
| father_id | FK Person? | 否 | 同 tree；≠ self |
| mother_id | FK Person? | 否 | 同 tree；≠ self |
| created_at / updated_at | datetime | 是 | |

约束：father_id/mother_id 不得形成环；父母 generation 应 ≤ 子女 generation−1（本 cut：环 hard-fail；世代不一致 warn 即可）。

#### Marriage / SpouseLink（配偶）
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | UUID/bigint | 是 | |
| tree_id | FK | 是 | |
| person_a_id | FK Person | 是 | |
| person_b_id | FK Person | 是 | ≠ person_a；同 tree |
| start_year | int? | 否 | 结婚年 |
| end_year | int? | 否 | 空=仍在续；有则 ≥ start_year |
| note | string(≤200)? | 否 | MVP 可选短注 |

约束：同一对 (a,b) 未 end 的链接至多一条。

#### Tree（家族树，最小）
| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | UUID/bigint | 是 | |
| owner_user_id | FK User | 是 | |
| title | string | 是 | 默认「我的家族」 |

#### User（最小）
仅需能登录并拥有 tree；字段细节交给 Eng，不进本 cut 验收面。

### 4. 最小 API 清单（Laravel RESTful 对齐边界）

前缀假设：`/api/v1`；均需认证；只操作当前用户的 tree。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /trees/current | 当前树元数据 |
| GET | /persons | 列表（可 ?root_id= 供构图） |
| POST | /persons | 创建成员 |
| GET | /persons/{id} | 详情 |
| PATCH | /persons/{id} | 更新字段/父母 |
| DELETE | /persons/{id} | 删除（本 cut：有子女则 409，须先解绑） |
| GET | /persons/{id}/tree | 返回构图 JSON（节点+边：parent、spouse；**2026-11-11 起另含 sibling**） |
| GET | /spouse-links | 列表 |
| POST | /spouse-links | 创建配偶绑定 |
| PATCH | /spouse-links/{id} | 更新起止年/注 |
| DELETE | /spouse-links/{id} | 解除 |
| GET | /sibling-links | 列表（2026-11-11） |
| POST | /sibling-links | 创建显式兄弟姐妹绑定（2026-11-11；幂等） |
| DELETE | /sibling-links/{id} | 解除（2026-11-11；本 cut UI 不做解绑管理） |

构图字段语义：root_id；nodes[] 含 id,name,gender,generation,birth_year,death_year；edges[] 为 type=parent(from→to)、type=spouse(a,b,link_id)，以及 **type=sibling(a,b,link_id)**（2026-11-11；显式边，不由共享父母推断写入 JSON）。

前端：消费 `/persons/{id}/tree`（或等价）用 D3/OrgChart 渲染；不得另起一套关系算法。详情里由共享父母**派生**的兄弟姐妹展示可与显式边合并去重，但不得发明 API 未给出的显式 sibling 边。

### 5. Acceptance criteria

**AC-1 成员录入**  
Proof: screenshot + API JSON（POST/GET person）  
QA: pass if 能创建并回读姓名/性别/世代/生卒；缺姓名返回 422。

**AC-2 父母绑定**  
Proof: API JSON + screenshot（树上可见亲子边）  
QA: pass if PATCH 设置 father_id/mother_id 后构图出现 parent 边；自指或环返回 4xx。

**AC-3 配偶绑定**  
Proof: API JSON + screenshot（配偶边可见）  
QA: pass if POST spouse-link 后双方在图上以 spouse 边相连；自配偶 422。

**AC-4 树可视化前后端一致**  
Proof: screenshot（前端图）+ API JSON（同 root 的 tree 响应）  
QA: pass if 图上节点数/亲子边/配偶边与 JSON 一致（抽 1 个 ≥3 代样例 fixture）。

**AC-5 删除保护**  
Proof: API JSON  
QA: pass if 仍有子女指向该成员时 DELETE → 409；解绑子女后可删。

**AC-6 树隔离**  
Proof: API JSON（第二用户或伪造 tree_id）  
QA: pass if 不能读写他人 tree 的 persons/links（401/403/404，不得 200）。

**Unlock order：** AC-1 → AC-2 → AC-3 → AC-4 → AC-5 → AC-6。AC-4 未 PASS 前不解锁视觉抛光/文档站点。

### 6. 非目标与后续阶段暂缓

- Phase 2+：GEDCOM、多配偶复杂史 UI、照片、协作、称谓引擎、打印、移动端、多树。
- 技术选型（Laravel / D3|OrgChart）是边界对齐，不是本 cut 的验收项；换等价栈须新 cut 仅当 API 形状或 Proof 类型变化。

### 7. Handoff

**Eng：** cut 日期 2026-11-06；AC-1…AC-6 按 unlock order；Proof 见上。本 cut 已 APPROVED。Boss 指定本地 Grok Bot 脚手架路径（**不开 Cloud Agent**）。

**QA（Startup QA Bot）：** 只按本 cut 重写验收包；禁止 soft-pass；同一 Proof 地图。

**Design（figma bro）：** 仅 In（成员录入 + 父母/配偶在树上可见）；Out 不进原型。

---

## PM review

- 活着的 SoT 路径：`docs/prd/yimai.md`（本节优先于口头/聊天补充）。
- 开放 cut：2026-11-11 delete-correction（APPROVED，含同日视觉收束）；2026-11-11 Explicit siblings（APPROVED，并列不取代）；底层 2026-11-06 AC-1…AC-6 仍有效且不得回退。
- Eng path：Cursor Auto only（user 2026-11-11）；DEL 设计见 `docs/superpowers/specs/2026-11-11-delete-correction-design.md`；视觉见 `docs/design/yimai-visual-component-spec-2026-11-11.md`；兄弟姐妹见 `docs/superpowers/specs/2026-11-11-explicit-siblings-design.md`。
- UI defaults（Boss）：单击节点只开 sheet、不换根；不做「我」标记；父母拆两个入口；配偶 start/end/note UI 全藏；tree JSON 字段名按 cut 锁定（含 sibling）；新 DEL 控件统一谱号。
- **过时限制作废：** 「添兄弟姐妹必须先有父母并复制 parent IDs」（旧 R3 / sibling-parent-copy gate）。
- 仓库已钉死：`owner/repo = mojunyu/yimai`（SoT：https://github.com/mojunyu/yimai/blob/main/docs/prd/yimai.md）。
- AC-5/AC-6 Feature proof：见 `docs/qa/ac-5-6-evidence.md`（PersonAc5Test + TreeIsolationAc6Test）。
- 合并与部署仍未授权；独立 SWE/QA 验收由 Master 后续安排。
