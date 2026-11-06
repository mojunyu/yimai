# 一脉 Frontend（AC-4）

极简家族树浏览：消费 **`GET /api/v1/persons/{id}/tree`** 的 JSON，用 D3 画节点与边。  
**禁止**在前端另算亲子/配偶关系；图上边数必须与同 root 的 API JSON 一致。

## 交互（Boss 默认）

- 单击节点 → 打开右侧 Person sheet（**不换根**）
- 「设为根」→ 才改 `root_id` 并重新请求 `/persons/{id}/tree`
- 父母/配偶展示来自 `edges[]`（`type=parent|spouse`），不是前端推导

## 跑起来

在仓库根目录：

```bash
composer install
touch database/database.sqlite   # 若尚无
php artisan migrate
php artisan yimai:demo --fresh   # 种子 3 代样例 + 打印 token
php artisan serve                # http://127.0.0.1:8000
```

浏览器打开：http://127.0.0.1:8000/app/

- 登录：`demo@yimai.test` / `password`
- 期望计数（3 代 fixture）：**nodes=5 · parent=4 · spouse=2**

也可在顶栏登录后，用控制台核对：

```js
// 页面已挂 window.yimaiCountTree
yimaiCountTree(/* 当前 state.tree 也可先 fetch */)
```

## 验收：图与 JSON 一致（AC-4 Proof）

1. 登录后打开 DevTools → Network，找到 `GET /api/v1/persons/{id}/tree`。
2. 记下响应里：
   - `nodes.length`
   - `edges.filter(e => e.type==='parent').length`
   - `edges.filter(e => e.type==='spouse').length`
3. 对照顶栏 stats（`nodes / parent / spouse`）——必须相同。
4. 截图：前端树 + Network JSON（同 root）。

样例 fixture（`ThreeGenerationFixture` / `php artisan yimai:demo`）：

| 项 | 值 |
| --- | --- |
| 成员 | 祖父、祖母、父、母、子 |
| parent 边 | 祖父→父、祖母→父、父→子、母→子（4） |
| spouse 边 | 祖父↔祖母、父↔母（2） |

后端自动化：

```bash
php artisan test --filter=TreeAc4Test
```

## 文件

| 路径 | 说明 |
| --- | --- |
| `index.html` | TopBar + Canvas + Sheet |
| `js/app.js` | 登录、拉树、D3 渲染、设为根 |
| `css/app.css` | 线框级样式（desktop-first ≥1024） |

由 Laravel `routes/web.php` 以同源方式挂到 `/app/*`（读本目录文件）。
