let app = document.getElementById('app');
app.innerHTML = `<div id="bg-img"></div>
    <div id="title">
        <div id="topbar">
            <span id="logo">芯宇识字</span>
            <span id="progress">0 / 0</span>
        </div>

    </div>
    <div id="menubar">
        <button class="menu-item" id="btnBook" type="button" tabindex="-1">字库：—</button>
        <button class="menu-item" id="btnMode" type="button" tabindex="-1">模式：顺序</button>
        <button class="menu-item" id="btnTip" type="button" tabindex="-1">图形：显示</button>
    </div>

    <div id="stage">
        <div id="tip"></div>
        <div id="word"></div>
        <div id="pinyin"></div>
    </div>

    <div id="bottombar">
        <span id="hint">◀ ▶ 换字 &nbsp;·&nbsp; ▼ 换字库 &nbsp;·&nbsp; ▲ 菜单</span>
        <span id="waring"></span>
        <span id="status"></span>
    </div>

    <div id="loading">正在读取字库…</div>`