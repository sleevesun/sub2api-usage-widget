use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::{env, fs};

#[test]
#[ignore = "requires local signed installer, portable file and latest.json; never installs or restarts the app"]
fn signed_release_matches_embedded_key_and_rejects_tampering() {
    let manifest = env::var("SUB2API_UPDATE_MANIFEST").expect("provide latest.json path");
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let manifest_text = fs::read_to_string(manifest).unwrap();
    let release: tauri_plugin_updater::RemoteRelease =
        serde_json::from_str(&manifest_text).unwrap();
    assert_eq!(release.version.to_string(), env!("CARGO_PKG_VERSION"));
    let pubkey_text = String::from_utf8(
        STANDARD
            .decode(config["plugins"]["updater"]["pubkey"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let key = PublicKey::decode(&pubkey_text).unwrap();
    for (platform, suffix, env_var) in [
        ("windows-x86_64", "setup", "SUB2API_UPDATE_INSTALLER"),
        (
            "windows-x86_64-portable",
            "portable",
            "SUB2API_UPDATE_PORTABLE",
        ),
    ] {
        let path = env::var(env_var).expect("provide the signed asset path");
        let version = &release.version;
        assert_eq!(release.download_url(platform).unwrap().as_str(), format!(
            "https://github.com/sleevesun/sub2api-usage-widget/releases/download/v{version}/Sub2API-Usage_{version}_x64-{suffix}.exe"
        ));
        let signature_text = String::from_utf8(
            STANDARD
                .decode(release.signature(platform).unwrap())
                .unwrap(),
        )
        .unwrap();
        let signature = Signature::decode(&signature_text).unwrap();
        let mut bytes = fs::read(path).unwrap();
        key.verify(&bytes, &signature, true)
            .expect("release must match the embedded public key");
        bytes[0] ^= 1;
        assert!(
            key.verify(&bytes, &signature, true).is_err(),
            "modified executables must be rejected"
        );
    }
}
