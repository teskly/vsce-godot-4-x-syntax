import * as net from "node:net";
import * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  State,
  StreamInfo,
} from "vscode-languageclient/node";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 6005;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const MAX_RECONNECT_DELAY_MS = 30_000;

type ConnectionStatus =
  | "starting"
  | "connected"
  | "disconnected"
  | "no-project"
  | "wrong-workspace"
  | "unsupported-server"
  | "invalid-settings";

interface LspSettings {
  host: string;
  port: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
}

let client: LanguageClient | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempt = 0;
let disposed = false;
let blockedByWorkspaceMismatch = false;
let status: ConnectionStatus = "disconnected";
let statusDetail = "";

let outputChannel: vscode.OutputChannel;
let traceOutputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSettings(): LspSettings {
  const configuration = vscode.workspace.getConfiguration("godot.lsp");
  const host = configuration.get<string>("host", DEFAULT_HOST).trim();
  const port = configuration.get<number>("port", DEFAULT_PORT);
  const autoReconnect = configuration.get<boolean>("autoReconnect", true);
  const maxReconnectAttempts = configuration.get<number>(
    "maxReconnectAttempts",
    DEFAULT_MAX_RECONNECT_ATTEMPTS,
  );

  return {
    host,
    port: Math.trunc(port),
    autoReconnect,
    maxReconnectAttempts: Math.max(0, Math.trunc(maxReconnectAttempts)),
  };
}

function validateSettings(settings: LspSettings): string | undefined {
  if (!settings.host) {
    return "Godot LSP host must not be empty.";
  }

  if (
    !Number.isInteger(settings.port) ||
    settings.port < 1 ||
    settings.port > 65535
  ) {
    return "Godot LSP port must be an integer between 1 and 65535.";
  }

  return undefined;
}

function setStatus(nextStatus: ConnectionStatus, detail = ""): void {
  status = nextStatus;
  statusDetail = detail;

  const labels: Record<ConnectionStatus, string> = {
    starting: "Connecting",
    connected: "Connected",
    disconnected: "Disconnected",
    "no-project": "No project",
    "wrong-workspace": "Wrong project",
    "unsupported-server": "Unsupported server",
    "invalid-settings": "Invalid settings",
  };

  statusBarItem.text = `$(plug) Godot LSP: ${labels[nextStatus]}`;
  statusBarItem.tooltip = detail
    ? `Godot LSP: ${labels[nextStatus]} — ${detail}`
    : `Godot LSP: ${labels[nextStatus]}`;
  statusBarItem.show();
}

async function getProjectFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  if (folders.length > 1) {
    log(
      "Multiple workspace folders are open. The first folder is used; multi-root projects are not supported.",
    );
  }

  const folder = folders[0];
  const projectFile = vscode.Uri.joinPath(folder.uri, "project.godot");

  try {
    await vscode.workspace.fs.stat(projectFile);
    return folder;
  } catch {
    return undefined;
  }
}

function createServerOptions(host: string, port: number): ServerOptions {
  return () =>
    new Promise<StreamInfo>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let connected = false;

      socket.on("connect", () => {
        connected = true;
        resolve({
          reader: socket,
          writer: socket,
        });
      });

      socket.on("error", (error) => {
        if (!connected) {
          reject(error);
          return;
        }

        log(`Godot LSP socket error: ${errorMessage(error)}`);
      });
    });
}

function createClient(
  workspaceFolder: vscode.WorkspaceFolder,
  settings: LspSettings,
): LanguageClient {
  const serverOptions = createServerOptions(settings.host, settings.port);
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "gdscript" }],
    workspaceFolder,
    outputChannel,
    traceOutputChannel,
    revealOutputChannelOn: RevealOutputChannelOn.Error,
    connectionOptions: {
      maxRestartCount: 0,
    },
    errorHandler: {
      error: (error) => {
        log(`Godot LSP connection error: ${errorMessage(error)}`);
        return {
          action: ErrorAction.Shutdown,
          message: "The connection to the Godot 4.x Language Server failed.",
        };
      },
      closed: () => {
        log("Godot LSP connection closed.");
        return {
          action: CloseAction.DoNotRestart,
        };
      },
    },
  };

  const languageClient = new LanguageClient(
    "godot4LanguageServer",
    "Godot 4.x Language Server",
    serverOptions,
    clientOptions,
  );

  languageClient.onNotification(
    "gdscript/capabilities",
    (capabilities: unknown) => {
      log(`Godot LSP capabilities: ${JSON.stringify(capabilities)}`);
    },
  );

  languageClient.onNotification(
    "gdscript_client/changeWorkspace",
    (parameters: unknown) => {
      void handleWorkspaceMismatch(languageClient, parameters);
    },
  );

  languageClient.onDidChangeState((event) => {
    if (client !== languageClient) {
      return;
    }

    if (event.newState === State.Starting) {
      setStatus("starting", `${settings.host}:${settings.port}`);
    } else if (event.newState === State.Running) {
      reconnectAttempt = 0;
      setStatus("connected", `${settings.host}:${settings.port}`);
    } else if (event.newState === State.Stopped) {
      client = undefined;
      setStatus("disconnected", "Godot Editor is not reachable.");
      scheduleReconnect();
    }
  });

  return languageClient;
}

async function handleWorkspaceMismatch(
  languageClient: LanguageClient,
  parameters: unknown,
): Promise<void> {
  if (client !== languageClient) {
    return;
  }

  blockedByWorkspaceMismatch = true;
  client = undefined;
  const details = parameters ? JSON.stringify(parameters) : "Godot opened another project.";
  log(`Godot LSP reported a workspace mismatch: ${details}`);
  setStatus(
    "wrong-workspace",
    "Open the VS Code project in the Godot Editor, then run Godot LSP: Reconnect.",
  );

  try {
    await languageClient.stop(2000);
  } catch (error) {
    log(`Failed to stop the mismatched Godot LSP client: ${errorMessage(error)}`);
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (disposed || blockedByWorkspaceMismatch || reconnectTimer) {
    return;
  }

  const settings = readSettings();
  if (!settings.autoReconnect) {
    return;
  }

  if (reconnectAttempt >= settings.maxReconnectAttempts) {
    log("Godot LSP reconnect limit reached. Use Godot LSP: Reconnect to try again.");
    return;
  }

  reconnectAttempt += 1;
  const delay = Math.min(
    1000 * 2 ** (reconnectAttempt - 1),
    MAX_RECONNECT_DELAY_MS,
  );
  setStatus(
    "disconnected",
    `Retry ${reconnectAttempt}/${settings.maxReconnectAttempts} in ${Math.ceil(delay / 1000)}s.`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void startClient();
  }, delay);
}

async function stopActiveClient(): Promise<void> {
  const activeClient = client;
  client = undefined;

  if (!activeClient) {
    return;
  }

  try {
    await activeClient.stop(2000);
  } catch (error) {
    log(`Failed to stop Godot LSP client: ${errorMessage(error)}`);
  }
}

async function startClient(): Promise<void> {
  if (disposed || blockedByWorkspaceMismatch || client) {
    return;
  }

  const settings = readSettings();
  const settingsError = validateSettings(settings);
  if (settingsError) {
    setStatus("invalid-settings", settingsError);
    log(settingsError);
    return;
  }

  const workspaceFolder = await getProjectFolder();
  if (!workspaceFolder) {
    setStatus(
      "no-project",
      "Open a workspace containing project.godot to use Godot LSP.",
    );
    return;
  }

  setStatus("starting", `${settings.host}:${settings.port}`);
  log(
    `Connecting to the Godot 4.x Language Server at ${settings.host}:${settings.port} for ${workspaceFolder.uri.fsPath}.`,
  );

  const languageClient = createClient(workspaceFolder, settings);
  client = languageClient;

  try {
    await languageClient.start();
    if (client !== languageClient) {
      return;
    }

    const serverInfo = languageClient.initializeResult?.serverInfo;
    const version = serverInfo?.version;
    if (version) {
      const majorVersion = Number.parseInt(version, 10);
      if (majorVersion !== 4) {
        blockedByWorkspaceMismatch = true;
        client = undefined;
        setStatus(
          "unsupported-server",
          `Godot ${version} was detected. Only Godot 4.x is supported.`,
        );
        log(`Unsupported Godot Language Server version: ${version}.`);
        await languageClient.stop(2000);
        return;
      }
      log(`Connected to Godot ${serverInfo.name ?? "Editor"} ${version}.`);
    } else {
      log(
        "Connected to the Godot LSP. The server did not report a version during initialization.",
      );
    }

    setStatus("connected", `${settings.host}:${settings.port}`);
  } catch (error) {
    if (client === languageClient) {
      client = undefined;
    }

    log(`Unable to connect to Godot LSP: ${errorMessage(error)}`);
    setStatus(
      "disconnected",
      `Cannot connect to ${settings.host}:${settings.port}. Start Godot 4.x Editor and open the project.`,
    );

    try {
      await languageClient.stop(2000);
    } catch (stopError) {
      log(`Failed to clean up failed Godot LSP client: ${errorMessage(stopError)}`);
    }

    scheduleReconnect();
  }
}

async function reconnect(): Promise<void> {
  clearReconnectTimer();
  reconnectAttempt = 0;
  blockedByWorkspaceMismatch = false;
  await stopActiveClient();
  await startClient();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel("Godot 4.x LSP");
  traceOutputChannel = vscode.window.createOutputChannel("Godot 4.x LSP Trace");
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "godot.lsp.showStatus";
  context.subscriptions.push(outputChannel, traceOutputChannel, statusBarItem);

  setStatus(
    "disconnected",
    "Start Godot 4.x Editor with the current project to enable LSP.",
  );
  log("Godot 4.x LSP extension activated.");

  context.subscriptions.push(
    vscode.commands.registerCommand("godot.lsp.connect", reconnect),
    vscode.commands.registerCommand("godot.lsp.reconnect", reconnect),
    vscode.commands.registerCommand("godot.lsp.showStatus", async () => {
      const settings = readSettings();
      await vscode.window.showInformationMessage(
        `Godot LSP: ${status}${statusDetail ? ` — ${statusDetail}` : ""} (${settings.host}:${settings.port})`,
      );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("godot.lsp")) {
        void reconnect();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reconnect();
    }),
  );

  await startClient();
}

export async function deactivate(): Promise<void> {
  disposed = true;
  clearReconnectTimer();
  await stopActiveClient();
}
