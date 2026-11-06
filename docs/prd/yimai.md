# 一脉 — Product PRD (living SoT)

> **PM review 节优先。** 顶节为 dated binding cuts。Eng 不得在 cut 获 APPROVED 前开 Cloud Agent。中途加范围须新 dated cut，禁止聊天漂移。

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
| GET | /persons/{id}/tree | 返回构图 JSON（节点+边：parent、spouse） |
| GET | /spouse-links | 列表 |
| POST | /spouse-links | 创建配偶绑定 |
| PATCH | /spouse-links/{id} | 更新起止年/注 |
| DELETE | /spouse-links/{id} | 解除 |

构图字段语义：root_id；nodes[] 含 id,name,gender,generation,birth_year,death_year；edges[] 为 type=parent(from→to) 或 type=spouse(a,b,link_id)。

前端：消费 `/persons/{id}/tree`（或等价）用 D3/OrgChart 渲染；不得另起一套关系算法。

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
- 开放 cut：2026-11-06（APPROVED，执行中）。
- Eng path：local Grok Bot scaffold（no Cloud Agent per Boss）。
- UI defaults（Boss）：单击节点只开 sheet、不换根；不做「我」标记；父母拆两个入口；配偶 start/end/note UI 全藏；tree JSON 字段名按本 cut 锁定。
- 仓库已钉死：`owner/repo = mojunyu/yimai`（SoT：https://github.com/mojunyu/yimai/blob/main/docs/prd/yimai.md）。
