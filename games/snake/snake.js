/* ============================================================
   snake.js — 贪吃蛇（逻辑层）
   只实现「状态 + 每帧逻辑 + 绘制」，其余交给 GameShell
   ============================================================ */
(function () {
    'use strict';

    var GRID = 20;            // 20 x 20 网格
    var CELL = 20;            // canvas 400 / 20
    var START_LEN = 3;

    // ---- 局内状态 ----
    var snake = [];
    var food = { x: 8, y: 10 };
    var dir = { dx: 1, dy: 0 };        // 当前生效方向
    var nextDir = { dx: 1, dy: 0 };    // 缓冲方向（避免一帧内连按导致自杀）

    var shell = null;

    /* ---------------- 工具 ---------------- */
    function randInt(max) { return Math.floor(Math.random() * max); }

    // 在空格中随机生成食物；返回 null 表示棋盘已满（通关）
    function spawnFood() {
        var occupied = {};
        snake.forEach(function (s) { occupied[s.x + ',' + s.y] = true; });
        var free = [];
        for (var x = 0; x < GRID; x++) {
            for (var y = 0; y < GRID; y++) {
                if (!occupied[x + ',' + y]) free.push({ x: x, y: y });
            }
        }
        if (!free.length) return null;
        return free[randInt(free.length)];
    }

    /* ---------------- 重置 ---------------- */
    function reset() {
        var c = Math.floor(GRID / 2);
        snake = [];
        for (var i = 0; i < START_LEN; i++) snake.push({ x: c - i, y: c });
        dir = { dx: 1, dy: 0 };
        nextDir = { dx: 1, dy: 0 };
        food = spawnFood() || { x: 0, y: 0 };
    }

    /* ---------------- 输入 ---------------- */
    function onDirection(dx, dy) {
        // 不允许 180° 掉头（用当前生效方向判断，防止快速连按钻死）
        if (dx === -dir.dx && dy === -dir.dy) return;
        nextDir = { dx: dx, dy: dy };
    }

    /* ---------------- 每帧逻辑 ---------------- */
    function onTick() {
        dir = { dx: nextDir.dx, dy: nextDir.dy };

        var head = snake[0];
        var newHead = { x: head.x + dir.dx, y: head.y + dir.dy };

        // 撞墙
        if (newHead.x < 0 || newHead.x >= GRID || newHead.y < 0 || newHead.y >= GRID) {
            return 'over';
        }

        var ate = (newHead.x === food.x && newHead.y === food.y);
        var body = ate ? snake : snake.slice(0, snake.length - 1);

        // 撞自己（去掉尾巴那一节后再判定）
        for (var i = 0; i < body.length; i++) {
            if (body[i].x === newHead.x && body[i].y === newHead.y) return 'over';
        }

        snake.unshift(newHead);
        if (!ate) snake.pop();

        if (ate) {
            shell.setScore(shell.score + 1);
            var f = spawnFood();
            if (!f) return 'win';     // 棋盘填满 = 通关
            food = f;
        }
        return null;
    }

    /* ---------------- 绘制 ---------------- */
    function onDraw(ctx, s) {
        var W = s.width, H = s.height;

        ctx.clearRect(0, 0, W, H);

        // 淡网格
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 0.5;
        for (var i = 0; i <= GRID; i++) {
            ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, H); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(W, i * CELL); ctx.stroke();
        }

        // 食物
        ctx.fillStyle = '#e94560';
        ctx.shadowColor = '#e94560';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // 蛇身
        for (var j = snake.length - 1; j >= 0; j--) {
            var seg = snake[j];
            var isHead = (j === 0);
            var pad = isHead ? 1 : 2;
            var t = j / Math.max(snake.length, 1);

            if (isHead) {
                ctx.fillStyle = '#ffd700';
                ctx.shadowColor = '#ffd700';
                ctx.shadowBlur = 12;
            } else {
                var g = Math.round(220 - t * 80);
                var b = Math.round(80 + t * 120);
                ctx.fillStyle = 'rgb(0,' + g + ',' + b + ')';
                ctx.shadowBlur = 0;
            }

            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(seg.x * CELL + pad, seg.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 4);
            } else {
                ctx.rect(seg.x * CELL + pad, seg.y * CELL + pad, CELL - pad * 2, CELL - pad * 2);
            }
            ctx.fill();
        }
        ctx.shadowBlur = 0;

        // 蛇头眼睛
        var h = snake[0];
        if (h) {
            var hx = h.x * CELL, hy = h.y * CELL;
            var eyeR = 3, off = 5;
            var e1, e2;
            if (dir.dx === 1)       { e1 = [hx + CELL - off - eyeR, hy + off];              e2 = [hx + CELL - off - eyeR, hy + CELL - off - eyeR]; }
            else if (dir.dx === -1) { e1 = [hx + off, hy + off];                             e2 = [hx + off, hy + CELL - off - eyeR]; }
            else if (dir.dy === -1) { e1 = [hx + off, hy + off];                             e2 = [hx + CELL - off - eyeR, hy + off]; }
            else                    { e1 = [hx + off, hy + CELL - off - eyeR];                e2 = [hx + CELL - off - eyeR, hy + CELL - off - eyeR]; }

            ctx.fillStyle = '#1a1a2e';
            ctx.beginPath(); ctx.arc(e1[0], e1[1], eyeR, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(e2[0], e2[1], eyeR, 0, Math.PI * 2); ctx.fill();
        }
    }

    /* ---------------- 启动 ---------------- */
    // 老版本的最高分 key 迁移，避免升级后记录归零
    if (window.HighScore) HighScore.migrate('snakeHighScore', 'snake');

    shell = new GameShell({
        mount: '#game-shell',
        gameKey: 'snake',
        width: 400,
        height: 400,
        tickMs: 150,
        tip: '← ↑ → ↓ / WASD 控制方向',
        onReset: reset,
        onTick: onTick,
        onDraw: onDraw,
        onDirection: onDirection
    });
})();
