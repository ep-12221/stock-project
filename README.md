# 股票模拟交易系统

一个使用 Vue 3、TypeScript 和 Node.js / Express 实现的股票模拟交易应用。用户、订单和成交记录都保存在内存中，**后端重启后数据清空**，无需安装数据库。

## 功能说明

- 注册、登录和退出。每个新账户有 100 万虚拟币，初始持仓为空。
- 展示三只股票的代码、名称、最新价和涨跌幅，行情每秒随机小幅波动。
- 支持限价买入、卖出，按价格优先、时间优先撮合，支持部分成交，并更新资金与持仓。
- 查看当前委托、历史委托、持仓和最近成交，以及可用和冻结的资金、持仓。
- 通过 WebSocket 推送行情、委托、持仓和成交变化，断线后自动重连并同步最新状态。
- 下单响应丢失时，可以按原请求标识重试；刷新页面后可恢复待确认委托，避免重复成交。

默认提供有限的系统买卖挂单，新用户注册后即可尝试交易。模拟行情的涨跌与撮合分开处理，只有实际委托匹配才会产生交易。操作示例见[双账户交易演示](docs/功能演示.md)。

## 启动步骤

需要 Node.js **22.14+（22.x）或 24.x**、npm **10+**。

### 本地开发

```bash
git clone https://github.com/ep-12221/stock-project.git
cd stock-project
npm ci
npm run dev
```

一个命令同时启动前后端：前端为 [localhost:5173](http://localhost:5173)，后端为 [localhost:3000](http://localhost:3000/api/health)。打开前端注册账户即可使用，按 Ctrl+C 停止服务。

默认无需配置文件。如需修改后端端口或关闭系统挂单，可参考 [.env.example](.env.example)，在项目根目录创建 .env。

### 构建后运行

先停止开发服务，再执行：

```bash
npm run build
npm start
```

访问 [localhost:3000](http://localhost:3000)。此时由后端同时提供前端静态页面、REST API 和 WebSocket。

### Docker

需要先启动 Docker Engine 或 Docker Desktop。在 Windows 的 WSL 中运行时，还需在 Docker Desktop 的 Settings → Resources → WSL Integration 中启用当前发行版，确认 `docker info` 能显示 Server 信息后，再在项目目录执行：

```bash
docker compose up --build
```

访问 [localhost:3000](http://localhost:3000)。运行前确保 3000 端口空闲，结束后用 `docker compose down` 清理容器。

## 关键架构决策

1. **价格树维护盘口顺序，撮合与结算共用一个提交边界。** 每只股票的买卖两侧各用一棵 AVL 树索引有挂单的价格，同价订单进入 FIFO 队列，服务端序号决定先后；成交完一档才删除价格节点，避免每次下单遍历、重建和排序整个盘口。树的更新先生成待提交操作，资金与持仓仍在受影响用户的副本上结算，冻结量及现金、股数守恒检查通过后才一起写回，命令内没有 `await`，WebSocket 在提交后发送。保留数组旧版和配置开关，通过相同订单流比对行为与性能；这也让数据结构优化的收益能被复验。代价是需要维护树与队列的不变量，而且账户复制、冻结校验仍有随受影响用户挂单量增长的成本，不能把整条下单链路视为对数复杂度。[价格树](apps/server/src/matching/price-tree-book.ts)、[撮合与提交](apps/server/src/services/trading.service.ts)、[结算校验](apps/server/src/matching/settlement.ts)。

2. **同一笔委托通过请求标识确认结果，网络超时不直接视为下单失败。** 后端以“用户 + `clientOrderId`”识别请求，并将股票、方向、限价和数量组成参数指纹，与订单一起提交。同标识同参数返回原订单的当前状态，参数不同则拒绝，避免重新撮合。前端在发出请求前把原委托写入 `sessionStorage`；超时或响应丢失后保留它、暂停新下单，刷新后由用户继续确认原单。代价是网络异常时暂时不能下新单；去重只对本次服务进程内、同用户同标识的委托生效，关闭标签页或清空存储后不保证恢复原标识。[后端去重](apps/server/src/services/trading.service.ts)、[前端确认流程](apps/client/src/stores/trading.ts)。

3. **实时同步发送当前状态快照，行情与账户分别判断版本。** HTTP 下单响应和 WebSocket 推送可能交错返回，因此前端统一按 `serverEpoch`（服务进程标识）、用户和版本接收状态，账户与行情分别使用 `accountVersion`、`marketVersion`，避免新行情把尚未到达的账户更新判为过期。连接重建后先接收完整当前状态，再恢复下单；历史记录超出快照窗口时通过游标接口补取。选择快照省去了断线期间事件补发和逐条重放的协议，但会重复传输数据，所以只推送当前状态和有限的近期记录。这一取舍适合三只股票的小规模应用，大规模行情应再考虑增量推送。[实时服务](apps/server/src/services/realtime.service.ts)、[前端同步](apps/client/src/stores/realtime.ts)。

## 代码阅读入口

| 要看什么           | 入口                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 一次下单如何完成   | [交易路由](apps/server/src/routes/trading.ts) → [交易服务](apps/server/src/services/trading.service.ts)，再按需查看价格树和结算模块    |
| 内存状态与系统挂单 | [memory-store.ts](apps/server/src/store/memory-store.ts)、[liquidity-seed.ts](apps/server/src/store/liquidity-seed.ts)                 |
| 前端下单与历史列表 | [trading.ts](apps/client/src/stores/trading.ts) 负责提交和重试，[history.ts](apps/client/src/stores/history.ts) 负责分页与实时记录合并 |
| 会话与实时连接     | [auth.ts](apps/client/src/stores/auth.ts) 负责身份和旧响应隔离，[realtime.ts](apps/client/src/stores/realtime.ts) 负责连接与重连       |

旧数组实现单独保存在 [legacy/trading-array.service.ts](apps/server/src/legacy/trading-array.service.ts)，用于配置切换和 A/B 对照。正式下单流程直接放在交易服务入口中。

## 测试

```bash
npm run check
```

依次执行类型检查、Lint、格式检查、测试和生产构建。目前包含 695 项测试，覆盖撮合优先级、部分成交、资金守恒、用户隔离、断线恢复和下单幂等等场景。详细结果见[验收记录](docs/交付验收与清单.md)。

### 撮合引擎切换与 A/B 测试

默认使用 `MATCHING_ENGINE=price-tree`。在根目录 `.env` 中改为 `MATCHING_ENGINE=array`，然后重启后端，即可运行完整保留的数组旧版；Docker Compose 也读取该变量。重启会清空当前内存状态，两版不在同一个实时盘口内混用。前端与 HTTP / WebSocket 协议相同。

```bash
npm run test:matching:ab
npm run bench:matching
```

第一条命令运行树结构、FIFO 和两版逐笔状态对照测试；第二条构建后端并执行独立进程的性能对照，默认测试三种场景、三档初始深度、每组每版三轮。测试方法、实际数据、复杂度和复现参数见[撮合引擎 A/B 测试](docs/撮合引擎AB测试.md)。

开发约定：新增功能或修复问题时，先补测试并确认失败，再实现并完成回归。

## AI 协作记录

[关键 Prompt 记录](docs/AI协作记录.md)整理了三个场景，包含审查修复、价格树 A/B 和 demo 重构，以及各自的调整和验证。更多实现说明见[详细设计](docs/股票模拟交易系统详细实现文档.md)。

交付材料、复现步骤和使用边界见[项目交付说明](docs/项目交付说明.md)。
