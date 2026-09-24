# Godot 4.x Syntax

VS Code syntax highlighting and GDScript snippets for Godot 4.x projects.

## LSP requires Godot 4.x Editor

**To use LSP features, you must have Godot 4.x Editor running with the current project open.**

This extension connects to Godot's built-in GDScript Language Server. It does not start Godot automatically and does not support Godot 3.x or older versions. Without a running Godot 4.x Editor, syntax highlighting and snippets continue to work, but LSP features are unavailable.

By default, the extension connects to `127.0.0.1:6005`. You can change the connection in VS Code settings:

- `godot.lsp.host` — Godot 4.x Language Server host, default `127.0.0.1`;
- `godot.lsp.port` — Godot 4.x Language Server TCP port, default `6005`;
- `godot.lsp.autoReconnect` — retry the connection after a disconnect;
- `godot.lsp.maxReconnectAttempts` — maximum automatic retries.

The host and port configured in VS Code must match `Editor Settings → Network → Godot 4.x Language Server` in Godot 4.x. If you change the Godot port, update `godot.lsp.port` in VS Code and run `Godot LSP: Reconnect`.

## Supported formats

- `.gd` — GDScript 4.x;
- `.tscn` — text scenes;
- `.tres` — text resources;
- `project.godot` — project configuration;
- `.gdshader` and `.gdshaderinc` — Godot shaders and shader includes;
- `.gdextension` — native extension configuration.

The extension also provides comments, brackets, quote pairing and basic indentation behavior where it is appropriate for the format. LSP is enabled only for `.gd` files; the other supported formats remain syntax-only.

## Scope

For `.gd` files, the built-in Godot 4.x Language Server provides diagnostics, completion, hover information, definitions, references, document symbols, signature help and rename support when the Godot Editor is running. The extension does not provide formatting or LSP support for `.tscn`, `.tres`, `project.godot`, shader files, `.gdextension` or binary Godot resources such as `.scn` and `.res`.

`.gdshaderinc` files use the same shader grammar as standalone shaders and do not require a `shader_type` declaration.

## License

MIT. See the `LICENSE` file included with the extension.
