// 引入 Electron 主进程模块。
const { app, BrowserWindow } = require("electron");
// 引入路径工具，用于定位同目录页面。
const path = require("node:path");
let mainWindow;
// 创建并加载小说阅读器窗口。
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 760, title: "小说阅读器", autoHideMenuBar: true,
    // 隔离渲染进程并关闭不必要的 Node 能力。
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 使用相对目录加载纯前端页面。
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  // 窗口关闭后释放主进程中的引用。
  mainWindow.on("closed", () => { mainWindow = null; });
}
// Electron 初始化完成后创建首个窗口。
app.whenReady().then(() => {
  createWindow();
  // macOS 点击 Dock 图标时，在没有窗口的情况下重新创建窗口。
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
// 非 macOS 平台在全部窗口关闭后退出应用。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
