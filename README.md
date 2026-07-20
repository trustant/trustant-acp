<h1 align="center">Trustable ACP Servrtd</h1>


# Installation

`./setup.sh`


# Development

First, run `./setup.sh` to ensure you have all the dependencies.

Then start the development stack:

```
npm run dev
```

This runs both watchers with hot reload — esbuild rebundles the web UI on any
frontend change, and `tsx watch` restarts the server on any backend change.

It targets `$WORKBENCH_DIR/trureact` on port 4096 by default. Override any of:

```
ACP_DIR=/path/to/app ACP_PORT=4097 ACP_ENV=/path/to/.env npm run dev
```

Secrets are read from `$WORKBENCH_DIR/.env`, loaded before the server changes into
the target directory. The target app's own `.env` is **not** read — that checkout is
user content, and reading it would let an app shadow provider credentials. Keys
already exported in your environment take precedence over the file, so externally
supplied keys (e.g. Claude, Pi) work without touching it. The file is optional; if
it is missing you get a warning and keys must come from the environment.

It is recommended you have Trustable up and running.

To build the Obsidian plugin bundle instead, use `npm run dev:plugin`.

