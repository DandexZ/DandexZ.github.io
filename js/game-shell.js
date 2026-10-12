/* ============================================================
   game-shell.js — 游戏壳（所有小游戏的公共骨架）
   ------------------------------------------------------------
   职责（每个游戏不用重复实现的）：
     · HUD（当前分 / 最高分，标签与单位可配）
     · 开始 / 暂停 / 重开 按钮 + 空格键
     · 键盘方向键 + WASD
     · 移动端触控方向键 + canvas 滑动手势
     · 画布点按 / 右键 / 长按（回合制与棋盘类游戏用）
     · 暂停 / 结束 / 通关 遮罩
     · 定帧循环（tickMs>0）或回合制（tickMs=0，操作后重绘）
     · 最高分读写（支持"越低越好"，如用时）
   游戏只需提供 opts：
     mount        容器选择器，默认 '#game-shell'
     gameKey      最高分标识，如 'snake'
     width/height canvas 尺寸，默认 400x400
     tickMs       每帧毫秒；默认 150；传 0 = 回合制（无定时器）
     tip          底部操作提示（外壳会自动补"空格：开始 / 暂停"）
     scoreLabel   当前分标签，默认 '🍎'
     bestLabel    最高分标签，默认 '🏆 最高'
     unit         数值单位，如 '秒'
     lowerIsBetter true = 数值越小越好（记"最快"）
     onReset(shell)          重置状态
     onTick(shell)           每帧逻辑；返回 'over' 或 'win' 结束本局
     onDraw(ctx, shell)      绘制
     onDirection(dx, dy)     收到方向输入（键盘/触控/滑动）
     onTap(x, y, button)     画布点按；x,y 为 canvas 坐标，button 为 'left'|'right'
     autostart   是否进入页面即开始，默认 false
   ============================================================ */
(function (global) {
    'use strict';

    var DIR_KEYS = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
        W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0]
    };

    var SWIPE_MIN = 24;   // 滑动手势最小位移(px)
    var LONG_PRESS_MS = 400;

    function GameShell(opts) {
        this.opts = opts || {};
        this.mount = document.querySelector(this.opts.mount || '#game-shell');
        if (!this.mount) throw new Error('GameShell: 找不到挂载容器 ' + (this.opts.mount || '#game-shell'));

        this.gameKey = this.opts.gameKey || 'default';
        // tickMs = 0 → 回合制：不跑定时器，靠操作驱动重绘（2048 这类）
        this.tickMs = (this.opts.tickMs === 0) ? 0 : (this.opts.tickMs || 150);
        this.turnBased = this.tickMs === 0;
        this.width = this.opts.width || 400;
        this.height = this.opts.height || 400;

        this.state = 'idle';          // idle | running | paused | over
        this.score = 0;
        this.best = global.HighScore ? HighScore.get(this.gameKey) : 0;
        this.timer = null;

        this._build();
        this._bind();

        if (this.opts.onReset) this.opts.onReset(this);
        this._render();

        if (this.opts.autostart) this.start();

        global.__activeShell = this;
    }

    /* ---------------- DOM ---------------- */
    GameShell.prototype._build = function () {
        var self = this;
        var unit = this.opts.unit ? ' ' + this.opts.unit : '';

        var wrap = document.createElement('div');
        wrap.className = 'game-shell';

        wrap.innerHTML =
            '<div class="hud">' +
                '<span class="hud-score">' + (this.opts.scoreLabel || '🍎') +
                    ' <b>0</b>' + unit + '</span>' +
                '<span class="hud-best">' + (this.opts.bestLabel || '🏆 最高') +
                    ' <b>' + (this.best || '—') + '</b>' + unit + '</span>' +
            '</div>' +
            '<div class="stage">' +
                '<canvas width="' + this.width + '" height="' + this.height + '"></canvas>' +
                '<div class="overlay">' +
                    '<div class="ov-title"></div>' +
                    '<div class="ov-sub"></div>' +
                '</div>' +
            '</div>' +
            '<div class="controls">' +
                '<button data-act="start">开始游戏</button>' +
                '<button data-act="pause" disabled>暂停</button>' +
                '<button data-act="restart">重开</button>' +
            '</div>' +
            '<p class="tip">' + (this.opts.tip || '方向键 / WASD 控制') +
                '　空格：开始 / 暂停</p>' +
            '<div class="dpad">' +
                '<button class="up"    data-dir="0,-1">▲</button>' +
                '<button class="left"  data-dir="-1,0">◀</button>' +
                '<button class="right" data-dir="1,0">▶</button>' +
                '<button class="down"  data-dir="0,1">▼</button>' +
            '</div>';

        this.mount.appendChild(wrap);
        this.root = wrap;
        this.canvas = wrap.querySelector('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.scoreNode = wrap.querySelector('.hud-score b');
        this.bestNode = wrap.querySelector('.hud-best b');
        this.overlay = wrap.querySelector('.overlay');
        this.ovTitle = wrap.querySelector('.ov-title');
        this.ovSub = wrap.querySelector('.ov-sub');
        this.startBtn = wrap.querySelector('[data-act="start"]');
        this.pauseBtn = wrap.querySelector('[data-act="pause"]');
        this.restartBtn = wrap.querySelector('[data-act="restart"]');
        this.dpad = wrap.querySelector('.dpad');

        this.startBtn.addEventListener('click', function () { self.start(); });
        this.pauseBtn.addEventListener('click', function () { self.togglePause(); });
        this.restartBtn.addEventListener('click', function () { self.reset(); });

        this.dpad.addEventListener('click', function (e) {
            var b = e.target.closest('button');
            if (!b) return;
            e.preventDefault();
            var p = b.dataset.dir.split(',');
            self._input(parseInt(p[0], 10), parseInt(p[1], 10));
        });
    };

    /* 客户端坐标 → canvas 位图坐标（CSS 缩放时也准确） */
    GameShell.prototype._toCanvas = function (clientX, clientY) {
        var r = this.canvas.getBoundingClientRect();
        // 无布局环境（如 jsdom）下 rect 为 0，退回 1:1 映射，避免除零
        var sx = r.width ? this.canvas.width / r.width : 1;
        var sy = r.height ? this.canvas.height / r.height : 1;
        return {
            x: (clientX - r.left) * sx,
            y: (clientY - r.top) * sy
        };
    };

    /* ---------------- 事件绑定 ---------------- */
    GameShell.prototype._bind = function () {
        var self = this;

        this._onKey = function (e) {
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            var dir = DIR_KEYS[e.key];
            if (dir) {
                e.preventDefault();
                self._input(dir[0], dir[1]);
                return;
            }
            if (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
                e.preventDefault();
                if (self.state === 'idle' || self.state === 'over') self.start();
                else self.togglePause();
            }
        };
        document.addEventListener('keydown', this._onKey);

        /* ---- 点按 / 右键 / 长按（棋盘类游戏） ---- */
        if (this.opts.onTap) {
            this.canvas.addEventListener('click', function (e) {
                // 长按已按"右键"处理过 → 吃掉紧随其后的 click，避免一次操作触发两次
                if (self._suppressClick) { self._suppressClick = false; return; }
                var p = self._toCanvas(e.clientX, e.clientY);
                self._tap(p.x, p.y, 'left');
            });

            this.canvas.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                var p = self._toCanvas(e.clientX, e.clientY);
                self._tap(p.x, p.y, 'right');
            });

            var lpTimer = null, lpPos = null;
            this.canvas.addEventListener('touchstart', function (e) {
                if (e.touches.length !== 1) return;
                lpPos = self._toCanvas(e.touches[0].clientX, e.touches[0].clientY);
                lpTimer = setTimeout(function () {
                    lpTimer = null;
                    self._suppressClick = true;
                    self._tap(lpPos.x, lpPos.y, 'right');   // 长按 = 右键插旗
                }, LONG_PRESS_MS);
            }, { passive: true });

            this.canvas.addEventListener('touchend', function () {
                if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
            }, { passive: true });
        }

        /* ---- 滑动手势（移动端） ---- */
        var sx = 0, sy = 0, tracking = false;

        this.canvas.addEventListener('touchstart', function (e) {
            if (e.touches.length !== 1) return;
            tracking = true;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
        }, { passive: true });

        this.canvas.addEventListener('touchmove', function (e) {
            if (tracking) e.preventDefault();   // 防止页面跟着滚
        }, { passive: false });

        this.canvas.addEventListener('touchend', function (e) {
            if (!tracking) return;
            tracking = false;
            var t = e.changedTouches[0];
            var dx = t.clientX - sx, dy = t.clientY - sy;
            if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
            if (Math.abs(dx) > Math.abs(dy)) self._input(dx > 0 ? 1 : -1, 0);
            else self._input(0, dy > 0 ? 1 : -1);
        }, { passive: true });
    };

    /* 统一方向输入入口：输入时若还没开始，自动开局 */
    GameShell.prototype._input = function (dx, dy) {
        if (this.state === 'idle') this.start();
        if (this.state !== 'running') return;
        if (this.opts.onDirection) this.opts.onDirection(dx, dy, this);
        if (this.turnBased) this._render();     // 回合制：操作后立即重绘
    };

    /* 统一点按入口 */
    GameShell.prototype._tap = function (x, y, button) {
        if (this.state === 'idle') this.start();
        if (this.state !== 'running') return;
        if (this.opts.onTap) this.opts.onTap(x, y, button, this);
    };

    /* ---------------- 渲染 ---------------- */
    GameShell.prototype._render = function () {
        this.scoreNode.textContent = this.score;
        if (this.opts.onDraw) this.opts.onDraw(this.ctx, this);
    };

    /** 公开重绘入口（回合制游戏改完状态后调用） */
    GameShell.prototype.render = function () { this._render(); };

    /** 由游戏调用：更新当前分（自动刷新最高分）
     *  第二个参数传 false 时只更新显示，不写入最高分
     *  （扫雷计时的中途刷新用它，避免"玩到一半就记进最快"） */
    GameShell.prototype.setScore = function (n, record) {
        this.score = n;
        this.scoreNode.textContent = n;

        if (record === false) return;

        if (this.opts.lowerIsBetter) {
            // 越低越好：0 视为"无记录"，且只在有记录时比较
            if (n > 0 && (this.best === 0 || n < this.best)) {
                this.best = n;
                this.bestNode.textContent = n;
                if (global.HighScore) HighScore.set(this.gameKey, n);
            }
        } else if (n > this.best) {
            this.best = n;
            this.bestNode.textContent = n;
            if (global.HighScore) HighScore.set(this.gameKey, n);
        }
    };

    /* ---------------- 遮罩 ---------------- */
    GameShell.prototype._showOverlay = function (title, sub, success) {
        this.ovTitle.textContent = title;
        this.ovTitle.className = 'ov-title' + (success ? ' success' : '');
        this.ovSub.textContent = sub || '';
        this.overlay.classList.add('is-visible');
    };

    GameShell.prototype._hideOverlay = function () {
        this.overlay.classList.remove('is-visible');
    };

    /* ---------------- 状态机 ---------------- */
    GameShell.prototype.start = function () {
        if (this.state === 'over') this.reset();          // 结束后按开始 = 重开
        if (this.state === 'running') return;
        this._hideOverlay();
        this.state = 'running';
        this.startBtn.textContent = '游戏中';
        this.startBtn.disabled = true;
        this.pauseBtn.disabled = false;
        this.pauseBtn.textContent = '暂停';
        this._clearTimer();
        var self = this;
        if (!this.turnBased) {
            this.timer = setInterval(function () { self._frame(); }, this.tickMs);
        }
        this._render();
    };

    /** 动态调速（俄罗斯方块升级加速用）。传 0 可切回回合制 */
    GameShell.prototype.setSpeed = function (ms) {
        this.tickMs = ms;
        this.turnBased = ms === 0;
        if (this.state === 'running') {
            this._clearTimer();
            var self = this;
            if (!this.turnBased) {
                this.timer = setInterval(function () { self._frame(); }, ms);
            }
        }
    };

    GameShell.prototype.togglePause = function () {
        if (this.state === 'running') {
            this.state = 'paused';
            this._clearTimer();
            this.pauseBtn.textContent = '继续';
            this._render();
            this._showOverlay('⏸ 已暂停', '点击「继续」或按空格恢复');
        } else if (this.state === 'paused') {
            this._hideOverlay();
            this.state = 'running';
            this.pauseBtn.textContent = '暂停';
            var self = this;
            this._clearTimer();
            if (!this.turnBased) {
                this.timer = setInterval(function () { self._frame(); }, this.tickMs);
            }
            this._render();
        }
    };

    GameShell.prototype.reset = function () {
        this._clearTimer();
        this._hideOverlay();
        this.state = 'idle';
        this.score = 0;
        this.scoreNode.textContent = '0';
        this.startBtn.textContent = '开始游戏';
        this.startBtn.disabled = false;
        this.pauseBtn.textContent = '暂停';
        this.pauseBtn.disabled = true;
        if (this.opts.onReset) this.opts.onReset(this);
        this._render();
    };

    GameShell.prototype.gameOver = function (msg) {
        this._clearTimer();
        this.state = 'over';
        this.startBtn.textContent = '再来一局';
        this.startBtn.disabled = false;
        this.pauseBtn.disabled = true;
        this._render();
        this._showOverlay('GAME OVER', (msg ? msg + '　' : '') + this._bestText());
    };

    GameShell.prototype.win = function (msg) {
        this._clearTimer();
        this.state = 'over';
        this.startBtn.textContent = '再来一局';
        this.startBtn.disabled = false;
        this.pauseBtn.disabled = true;
        this._render();
        this._showOverlay('🎉 通关！', (msg ? msg + '　' : '') + this._bestText(), true);
    };

    GameShell.prototype._bestText = function () {
        var unit = this.opts.unit ? this.opts.unit : '';
        if (!this.best) return '暂无记录';
        return (this.opts.lowerIsBetter ? '最快 ' : '最高 ') + this.best + unit + (unit ? '' : ' 分');
    };

    GameShell.prototype._frame = function () {
        if (this.state !== 'running') return;
        var r = this.opts.onTick ? this.opts.onTick(this) : null;
        if (r === 'over') { this.gameOver(); return; }
        if (r === 'win')  { this.win(); return; }
        this._render();
    };

    GameShell.prototype._clearTimer = function () {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    };

    /* 页面卸载时清定时器 */
    global.addEventListener('pagehide', function () {
        if (global.__activeShell) global.__activeShell._clearTimer();
    });

    global.GameShell = GameShell;
})(window);
