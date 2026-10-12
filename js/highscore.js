/* ============================================================
   highscore.js — 全站最高分存储
   每个游戏一个 key： minigame:best:<gameKey>
   旧 key 可通过 HighScore.migrate() 平滑迁移，不丢记录
   ============================================================ */
(function (global) {
    'use strict';

    var PREFIX = 'minigame:best:';
    var memory = {};   // localStorage 不可用时的兜底

    function storageOK() {
        try {
            global.localStorage.setItem('__t', '1');
            global.localStorage.removeItem('__t');
            return true;
        } catch (e) {
            return false;
        }
    }

    var HAS_LS = storageOK();

    var HighScore = {
        key: function (gameKey) { return PREFIX + gameKey; },

        get: function (gameKey) {
            var raw = HAS_LS
                ? global.localStorage.getItem(PREFIX + gameKey)
                : memory[gameKey];
            var n = parseInt(raw, 10);
            return isNaN(n) ? 0 : n;
        },

        set: function (gameKey, value) {
            if (HAS_LS) {
                global.localStorage.setItem(PREFIX + gameKey, String(value));
            } else {
                memory[gameKey] = String(value);
            }
            return value;
        },

        /** 只有更高才写入，返回最终记录值 */
        raise: function (gameKey, value) {
            var best = HighScore.get(gameKey);
            if (value > best) { HighScore.set(gameKey, value); return value; }
            return best;
        },

        /** 把老的裸 key（如 'snakeHighScore'）搬到新命名空间，只在有值时迁移一次 */
        migrate: function (oldKey, gameKey) {
            if (!HAS_LS) return;
            var legacy = parseInt(global.localStorage.getItem(oldKey), 10);
            if (isNaN(legacy)) return;
            if (HighScore.get(gameKey) < legacy) HighScore.set(gameKey, legacy);
            global.localStorage.removeItem(oldKey);
        }
    };

    global.HighScore = HighScore;
})(window);
