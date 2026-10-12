/* ============================================================
   physics.js — 纯圆形刚体物理（位置约束法 / PBD）
   ------------------------------------------------------------
   只做圆：重力、圆-圆碰撞、边界反弹、切向摩擦、静止收敛、碰撞上报。
   不含 DOM / 渲染 / 游戏规则，因此可以在 node 里直接跑数值断言。
   UMD：浏览器挂 window.CirclePhysics，node 走 module.exports。

   为什么用位置约束而不是纯冲量积分：
   圆堆叠时冲量法容易互相穿透、抖动、甚至"炸开"；PBD 先做位置修正
   （各让一半，留 slop 容忍微小穿透），再顺带修正法向/切向速度，
   少量迭代就能得到稳定的堆叠。
   ============================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();            // node
    } else {
        root.CirclePhysics = factory();        // 浏览器
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function World(opts) {
        opts = opts || {};
        this.width  = opts.width  || 400;
        this.height = opts.height || 560;

        this.gravity     = opts.gravity == null ? 1600 : opts.gravity;      // px/s²
        this.restitution = opts.restitution == null ? 0.12 : opts.restitution;      // 水果间弹性
        this.wallRestitution = opts.wallRestitution == null ? 0.22 : opts.wallRestitution; // 墙体弹性
        this.friction    = opts.friction == null ? 0.28 : opts.friction;    // 切向动摩擦
        // 静摩擦阈值：切向相对速度低于它就直接清零（不再滑动）。
        // 不加这个，堆叠会在位置修正下以几 px/s 缓慢"蠕动"，看着像永远在动。
        this.staticFrictionSpeed = opts.staticFrictionSpeed == null ? 20 : opts.staticFrictionSpeed;
        this.iterations  = opts.iterations || 8;      // 每子步的约束迭代次数
        this.substeps    = opts.substeps || 2;
        this.slop        = opts.slop == null ? 0.5 : opts.slop;   // 允许的微小穿透（抗抖动）
        this.linearDamping = opts.linearDamping == null ? 0.999 : opts.linearDamping;
        this.sleepSpeed  = opts.sleepSpeed == null ? 12 : opts.sleepSpeed;  // 低于此速度快速衰减
        // 恢复系数阈值：接近速度低于它时按"完全非弹性"处理（e=0）。
        // 不加这个，重力每步注入的 ~g·h 速度会让静止的堆积永远微抖。
        this.restThreshold = opts.restThreshold == null ? 40 : opts.restThreshold;
        this.maxVel      = opts.maxVel || 2600;       // 限速，避免极端穿透
        // 单次位置修正上限：深重叠时若一次弹开太多，物体会被"瞬移"出去（甚至飞出盒子）。
        // 限幅后深重叠会分几步缓慢化开，行为稳定得多。
        this.maxCorrection = opts.maxCorrection == null ? 4 : opts.maxCorrection;
        // 注意：数值属性叫 maxVel，别叫 maxSpeed —— 后者是本类的方法名，
        // 实例属性会遮蔽原型方法（真踩过：this.maxSpeed() is not a function）

        this.bodies = [];
        this.contacts = [];      // 本步发生接触的 [a, b] 对（合并逻辑的数据来源）
        this._nextId = 1;
        this._contactKeys = null;
        this.steps = 0;
    }

    /* ---------------- 增删 ---------------- */
    World.prototype.add = function (b) {
        var body = {
            id: this._nextId++,
            x: b.x,
            y: b.y,
            vx: b.vx || 0,
            vy: b.vy || 0,
            r: b.r,
            tier: b.tier == null ? 0 : b.tier,
            data: b.data
        };
        this.bodies.push(body);
        return body;
    };

    World.prototype.remove = function (body) {
        var i = this.bodies.indexOf(body);
        if (i >= 0) this.bodies.splice(i, 1);
    };

    World.prototype.clear = function () {
        this.bodies.length = 0;
        this.contacts.length = 0;
        this.steps = 0;
    };

    /* ---------------- 推进 ---------------- */
    World.prototype.step = function (dt) {
        if (!(dt > 0)) return;
        var h = dt / this.substeps;
        var n = this.bodies.length;

        this.contacts.length = 0;
        this._contactKeys = {};
        for (var z = 0; z < n; z++) this.bodies[z]._supported = false;

        for (var k = 0; k < this.substeps; k++) {
            // 1) 积分（重力 + 阻尼 + 限速 + 位移）
            //    resting 的物体本步不加重力：否则它每步被推下去一点点，
            //    位置修正又会沿斜向法线把它横向弹开，堆积就会以 2~3px/s 缓慢"摊开"。
            //    失去支撑时 _touched 会变 false → resting 自动解除，恢复正常下落。
            var damp = Math.pow(this.linearDamping, h * 60);
            for (var i = 0; i < n; i++) {
                var b = this.bodies[i];
                if (b.resting) continue;

                b.vy += this.gravity * h;
                b.vx *= damp;
                b.vy *= damp;

                var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
                if (sp > this.maxVel) {
                    var s = this.maxVel / sp;
                    b.vx *= s;
                    b.vy *= s;
                }
                b.x += b.vx * h;
                b.y += b.vy * h;
            }

            // 2) 约束迭代（位置修正 + 速度修正）
            for (var it = 0; it < this.iterations; it++) {
                for (var a = 0; a < n; a++) {
                    for (var c = a + 1; c < n; c++) {
                        this._solvePair(this.bodies[a], this.bodies[c], it === 0 && k === 0);
                    }
                }
                for (var w = 0; w < n; w++) this._solveWalls(this.bodies[w]);
            }
        }

        this._settle();
        this.steps++;
    };

    World.prototype._record = function (a, b) {
        var key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
        if (this._contactKeys[key]) return;
        this._contactKeys[key] = true;
        this.contacts.push([a, b]);
    };

    /* 圆-圆：位置修正（各让一半）+ 法向冲量（含恢复系数）+ 切向摩擦 */
    World.prototype._solvePair = function (a, b, record) {
        var dx = b.x - a.x, dy = b.y - a.y;
        var rsum = a.r + b.r;
        var d2 = dx * dx + dy * dy;
        if (d2 > rsum * rsum) return;

        var d = Math.sqrt(d2);
        var nx, ny;
        if (d < 1e-6) {                     // 完全重合：给个确定性的分离方向
            nx = 1; ny = 0; d = 0;
        } else {
            nx = dx / d; ny = dy / d;
        }

        if (record) this._record(a, b);

        // 支撑判定：只有"竖向"接触才算被托住。
        // 若只要求"有接触"，一起下落的水平接触群体会被整体冻在空中（真踩过：
        // 出现速度 0、resting=true 却悬在容器上方的水果）。
        if (ny > 0.2) a._supported = true;          // b 在 a 下方 → a 被 b 托住
        else if (ny < -0.2) b._supported = true;    // a 在 b 下方 → b 被 a 托住

        var pen = rsum - d;
        if (pen > this.slop) {
            var corr = Math.min((pen - this.slop) * 0.5, this.maxCorrection);
            a.x -= nx * corr; a.y -= ny * corr;
            b.x += nx * corr; b.y += ny * corr;
        }

        // 法向相对速度：< 0 表示正在靠近
        var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
            // 慢速接触视为完全非弹性，否则堆积区会被重力一点点"喂"成永动机
            var e = (-vn < this.restThreshold) ? 0 : this.restitution;
            var jn = -(1 + e) * vn * 0.5;                     // 等质量
            a.vx -= nx * jn; a.vy -= ny * jn;
            b.vx += nx * jn; b.vy += ny * jn;

            // 切向摩擦：低速走静摩擦（直接抹掉相对滑动），高速走动摩擦
            var tx = -ny, ty = nx;
            var vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
            var fr = (Math.abs(vt) < this.staticFrictionSpeed) ? 1 : this.friction;
            var jt = -vt * fr * 0.5;
            a.vx -= tx * jt; a.vy -= ty * jt;
            b.vx += tx * jt; b.vy += ty * jt;
        }
    };

    /* 墙体：左右下三面有界，顶部开放（水果从上方落）。
       同样使用恢复系数阈值：贴着墙/地静止时把法向速度清零，而不是留 22% 反弹。 */
    World.prototype._solveWalls = function (b) {
        var e = this.wallRestitution;
        var th = this.restThreshold;
        if (b.x - b.r < 0) {
            b.x = b.r;
            if (b.vx < 0) b.vx = (Math.abs(b.vx) < th) ? 0 : -b.vx * e;
        } else if (b.x + b.r > this.width) {
            b.x = this.width - b.r;
            if (b.vx > 0) b.vx = (Math.abs(b.vx) < th) ? 0 : -b.vx * e;
        }
        if (b.y + b.r > this.height) {
            b.y = this.height - b.r;
            if (b.vy > 0) b.vy = (Math.abs(b.vy) < th) ? 0 : -b.vy * e;
        }
        // 地面是硬支撑；左右墙不算"托住"（贴墙但悬空的东西应该继续往下滑）
        if (b.y + b.r > this.height - 0.0001) b._supported = true;
    };

    /* 静止收敛：
       1) 被托住（竖向接触或落地）且速度低于阈值 → 速度直接归零。
          这一步是必要的：法向冲量只消掉"相对"速度，两球共同下坠的那份会留下，
          叠加重力每步注入的速度，堆积就会以几 px/s 永远蠕动。
       2) 其余低速体做温和衰减，消掉残余晃动。 */
    World.prototype._settle = function () {
        var s = this.sleepSpeed;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            if (b._supported && sp < s) {
                b.vx = 0;
                b.vy = 0;
                b.resting = true;
            } else {
                b.resting = false;
                if (sp < s) { b.vx *= 0.35; b.vy *= 0.35; }
            }
        }
    };

    /* ---------------- 诊断（供测试 / 调试用） ---------------- */
    World.prototype.maxOverlap = function () {
        var worst = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            for (var j = i + 1; j < this.bodies.length; j++) {
                var a = this.bodies[i], b = this.bodies[j];
                var d = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
                var ov = (a.r + b.r) - d;
                if (ov > worst) worst = ov;
            }
        }
        return worst;
    };

    World.prototype.maxSpeed = function () {
        var worst = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            var s = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
            if (s > worst) worst = s;
        }
        return worst;
    };

    /** 总机械能（动能 + 重力势能），用于验证"能量在衰减而不是被注入" */
    World.prototype.energy = function () {
        var e = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            e += 0.5 * (b.vx * b.vx + b.vy * b.vy) + this.gravity * (this.height - b.y);
        }
        return e;
    };

    /** 越界检测：返回越界体的数量（忽略 slop） */
    World.prototype.outOfBounds = function (tol) {
        tol = tol == null ? 1 : tol;
        var bad = 0;
        for (var i = 0; i < this.bodies.length; i++) {
            var b = this.bodies[i];
            if (b.x < b.r - tol || b.x > this.width - b.r + tol ||
                b.y > this.height - b.r + tol ||
                b.x !== b.x || b.y !== b.y) {          // NaN 也算越界
                bad++;
            }
        }
        return bad;
    };

    /** 是否全部静止（速度上限低于阈值） */
    World.prototype.isSettled = function (tol) {
        tol = tol == null ? 2 : tol;
        return this.maxSpeed() < tol;
    };

    return { World: World };
});
