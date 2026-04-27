// Cargo build script.
//
// Loads `.env.build` from the repo root (one level up from `src-tauri/`) and
// re-exports each KEY=VALUE pair to the compiler via `cargo:rustc-env`, which
// is what `option_env!()` reads at macro expansion time. Without this,
// `ELEVENLABS_API_KEY` (and any other build-time secrets baked into the binary)
// would always be `None` during `pnpm tauri dev` because Cargo doesn't read
// `.env*` files on its own — only Vite does, and only for the JS bundle.
//
// `cargo:rerun-if-changed=../.env.build` makes Cargo re-execute this script
// whenever the file changes, so editing the key triggers a recompile of the
// crates that consume it (e.g. speech.rs).

use std::fs;
use std::path::PathBuf;

fn main() {
    let env_build_path: PathBuf = PathBuf::from("..").join(".env.build");

    // Always tell Cargo to re-run if the env file changes (or appears).
    println!("cargo:rerun-if-changed=../.env.build");

    if let Ok(contents) = fs::read_to_string(&env_build_path) {
        for raw in contents.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            // Strip optional surrounding quotes on the value (e.g. KEY="abc").
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            if key.is_empty() {
                continue;
            }
            // Make the variable available to `option_env!()` and to the build
            // graph as an env-var dependency.
            println!("cargo:rustc-env={key}={value}");
            println!("cargo:rerun-if-env-changed={key}");
        }
    }

    tauri_build::build();
}
