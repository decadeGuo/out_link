/**
 * xinyu_word 字库加载器
 * ---------------------------------------------------------------------------
 * 只从线上拉字库，页面里不再带内置字库那份副本。
 * 故意不做 localStorage 缓存：改了字库就直接生效，
 * 不会出现「远端已更新、电视上还是旧字库」这种查不出来的怪现象。
 *
 *   REMOTE_URLS 里的字库 —— **按顺序**试，第一个能拿到数据的就用
 *   第一项是 "./js/words_origin.js"（同源优先），后面才是各镜像站
 *
 * 失败 ≠ 放弃。一个字都没拉到时 ready 会 reject：
 *   1. 调用方（after.js）必须把失败原因显示到页面上，不许吞掉
 *   2. 后台还会按 2s/5s/15s 再试，成功后通过 XinyuWords.onUpdate(snap)
 *      通知页面热更新，不用重启应用就能用上新字库
 *
 * 用法：
 *   <script src="js/words-loader.js"></script>
 *   <script>
 *     XinyuWords.ready.then(function (snap) {
 *       // snap.source           : "remote"
 *       // snap.version          : 字库版本号
 *       // snap.youeryuan        : 幼儿园学的字
 *       // snap.common           : 常见字
 *       // snap.errors           : 拉取过程中记录的错误
 *     }, function (err) {
 *       // err.message 里是每个远端地址失败的原因，直接摆到页面上
 *     });
 *   </script>
 *
 * 说明：远端文件格式为 window.words_youeryuan = [...] 和 window.words_youeryuan_common = [...]，
 *       和仓库里的 js/words_origin.js 完全一致，改完直接传远端即可。
 * ---------------------------------------------------------------------------
 */
(function (global) {
    "use strict";

    /* ========== 改这里：字库地址，**按顺序**试，第一个成功的就用 ========== */
    // 注意：这份字库地址是**独立的一列**，不跟 loader.js 的 remoteBases 走，两处都要改。
    var REMOTE_URLS = [
        "./js/words_origin.js",                                                   // 同源（和 index.html 一个站）
        "https://decadeguo.github.io/out_link/js/words_origin.js",                // GitHub Pages
        "https://cdn.jsdelivr.net/gh/decadeGuo/out_link@main/js/words_origin.js", // jsDelivr（分支引用有缓存，更新会延迟）
        "http://tlcdoebqd.hn-bkt.clouddn.com/words/js/words_origin.js"            // 七牛（http，页面是 https 时会被浏览器拦掉）
    ];
    /* ========================================================================== */

    var TIMEOUT = 5000;       // 单个地址的超时（毫秒）
    var BUDGET = 10000;        // 首屏：所有远端地址加起来最多等这么久，别让界面干等
    var RETRY_BUDGET = 20000; // 后台重试：没人在等，可以慢慢试

    // 远端失败后的后台重试间隔。电视刚唤醒 / Wi-Fi 抖动时第一次请求很容易超过 4s，
    // 如果一次失败就再也不试，就会出现「远端文件已经更新了，页面还是旧内容」的问题。
    var RETRY_DELAYS = [2000, 5000, 15000];

    var api = {
        ready: null,     // Promise<snap>
        data: null,      // 加载完成后的字库数据
        onUpdate: null,  // function(snap)：后台重试成功后的热更新回调
        refresh: null    // function：强制重新拉一次远端
    };

    /* ------------------------------ 工具 ------------------------------ */

    // 给 URL 拼时间戳，绕开浏览器 / WebView 的 HTTP 缓存。
    // 静态服务器通常只回 Last-Modified（没有 Cache-Control / ETag），
    // 浏览器会按「启发式缓存」直接复用旧脚本，改了远端也不生效。
    function bust(url) {
        return url + (url.indexOf("?") < 0 ? "?" : "&") + "_t=20260920";
    }

    function reason(e) {
        return e && e.message ? e.message : String(e);
    }

    // 动态加载一个 script，支持超时
    function loadScript(url, timeout) {
        return new Promise(function (resolve, reject) {
            var el = document.createElement("script");
            var timer = null;
            var settled = false;

            function finish(err) {
                if (settled) return;
                settled = true;
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (err) {
                    el.onload = null;
                    el.onerror = null;
                    if (el.parentNode) el.parentNode.removeChild(el);
                    reject(err);
                } else {
                    resolve();
                }
            }

            el.src = url;
            el.async = false; // 动态脚本默认是 async，这里保证按顺序
            el.onload = function () { finish(null); };
            el.onerror = function () { finish(new Error("脚本加载失败: " + url)); };

            if (timeout > 0) {
                timer = setTimeout(function () {
                    finish(new Error("脚本加载超时(" + timeout + "ms): " + url));
                }, timeout);
            }

            document.head.appendChild(el);
        });
    }

    function snapshot() {
        return {
            source: "remote", // 字库只有远端一个来源
            version: global.WORDS_VERSION || "未知",
            // 版权 / 警告文案：来自字库文件里的 window.WORING
            waring: global.WORING || "",
            youeryuan: global.words_youeryuan || [],
            common: global.words_youeryuan_common || []
        };
    }

    /* ---------------------------- 远端加载 ---------------------------- */

    // 多个地址按顺序试，在预算内谁先成功就用谁
    function fromRemote(budget) {
        var errors = [];
        var deadline = Date.now() + (budget || BUDGET);

        function attempt(i) {
            var remain = deadline - Date.now();
            if (i >= REMOTE_URLS.length || remain <= 0) {
                return Promise.reject(new Error(errors.length
                    ? errors.join(" | ")
                    : "没有配置可用的远端地址"));
            }

            var url = REMOTE_URLS[i];
            return loadScript(bust(url), Math.min(TIMEOUT, remain)).then(function () {
                if (!global.words_youeryuan && !global.words_youeryuan_common) {
                    errors.push("远端脚本执行了，但没拿到字库数据: " + url);
                    return attempt(i + 1);
                }
                return snapshot();
            }, function (e) {
                // 用 then 的第二个参数接失败，不要用 catch：
                // 否则上面 return 的 rejection 会被同一个 catch 再兜一次
                errors.push(reason(e));
                return attempt(i + 1);
            });
        }

        return attempt(0);
    }

    // 远端失败后的后台重试：成功后热更新给页面，不再需要重启应用
    var retryTimer = null;
    var retryStep = 0;

    function cancelRetry() {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        retryStep = 0;
    }

    function scheduleRetry() {
        if (retryStep >= RETRY_DELAYS.length) return; // 试够了就停下，页面上那句失败提示会一直留着
        var delay = RETRY_DELAYS[retryStep++];
        retryTimer = setTimeout(function () {
            retryTimer = null;
            fromRemote(RETRY_BUDGET)
                .then(function (snap) {
                    snap.errors = [];
                    api.data = snap;
                    cancelRetry();
                    if (typeof api.onUpdate === "function") api.onUpdate(snap);
                })
                .catch(function (e) {
                    api.lastError = reason(e);
                    scheduleRetry();
                });
        }, delay);
    }

    function load() {
        var errors = [];
        return fromRemote().then(function (snap) {
            cancelRetry();
            snap.errors = errors;
            api.data = snap;
            return snap;
        }, function (e) {
            // 一个字都没拉到：页面没有任何可显示的字库，reject 出去让调用方
            // 把失败原因显示出来；后台继续按 2s/5s/15s 追，追到了热更新
            errors.push(reason(e));
            api.lastError = reason(e);
            scheduleRetry();
            throw new Error(errors.join(" | "));
        });
    }

    /* ------------------------------ 对外 ------------------------------ */

    api.ready = load();

    // 供「检查更新」按钮调用：不要重启应用，直接重新拉一次远端
    api.refresh = function () {
        cancelRetry();
        global.words_youeryuan = null;
        global.words_youeryuan_common = null;
        global.WORDS_VERSION = null;
        global.WORING = null;
        api.ready = load();
        return api.ready;
    };

    global.XinyuWords = api;
})(window);
