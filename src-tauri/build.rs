// Copies exactly the files relay.py is allowed to serve into web-dist/, which Tauri embeds.
// tests/, relay.py, .git and everything else stay out of the app.
use std::{fs, path::Path};

const FILES: &[&str] = &["index.html", "styles.css"];
const DIRS: &[(&str, &[&str])] = &[("src", &["js", "txt"]), ("public", &["png", "svg", "ico"]), ("data", &["json"])];

// Only rewrites a file when its bytes changed, so builds don't churn.
fn sync(from: &Path, to: &Path) {
    let bytes = fs::read(from).expect("read web file");
    if fs::read(to).ok().as_deref() != Some(bytes.as_slice()) {
        fs::write(to, bytes).expect("write web file");
    }
}

fn sync_dir(from: &Path, to: &Path, exts: &[&str]) {
    fs::create_dir_all(to).expect("create web-dist dir");
    for entry in fs::read_dir(from).expect("read web dir") {
        let path = entry.expect("dir entry").path();
        let name = path.file_name().expect("file name");
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            sync_dir(&path, &to.join(name), exts);
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.contains(&e)) {
            sync(&path, &to.join(name));
        }
    }
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest).join("..");
    let out = Path::new(&manifest).join("web-dist");
    fs::create_dir_all(&out).expect("create web-dist");
    for f in FILES {
        sync(&root.join(f), &out.join(f));
        println!("cargo:rerun-if-changed=../{f}");
    }
    for (dir, exts) in DIRS {
        sync_dir(&root.join(dir), &out.join(dir), exts);
        println!("cargo:rerun-if-changed=../{dir}");
    }
    // Declaring the app's commands makes each one need an explicit permission in capabilities/.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["rpc", "evm_rpc", "rpc_info", "open_site"])),
    )
    .expect("tauri build step failed");
}
