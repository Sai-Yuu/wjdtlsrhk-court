const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');

const PORT = 3847;
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '디스코드 모의법원',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
    backgroundColor: '#1a2744',
  });

  // 외부 링크는 기본 브라우저로 열기
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${PORT}`)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // JSON DB 저장 경로를 userData로 설정
  process.env.USER_DATA_PATH = app.getPath('userData');
  process.env.PORT = String(PORT);

  createWindow();

  // 로딩 화면 표시
  mainWindow.loadFile(path.join(__dirname, 'public', 'loading.html'));
  mainWindow.show();

  try {
    const { start } = require('./server');
    await start(PORT);
    mainWindow.loadURL(`http://localhost:${PORT}`);
  } catch (err) {
    dialog.showErrorBox(
      '서버 시작 실패',
      `포트 ${PORT}를 사용할 수 없습니다.\n다른 프로그램이 같은 포트를 사용 중일 수 있습니다.\n\n${err.message}`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
