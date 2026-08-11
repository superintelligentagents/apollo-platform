use chrono::{Duration, NaiveDate};
use dirs;
use reqwest::blocking::{
    multipart::{Form, Part},
    Client,
};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog;
use tempfile::NamedTempFile;
use url::Url;

#[derive(Serialize)]
struct Visit {
    id: i64,
    url: String,
    title: String,
    visited_at: String,
    from_visit: i64,
    domain: String,
    search_term: String,
}

#[derive(Serialize)]
struct Cluster {
    cluster_id: i64,
    visits: Vec<Visit>,
}

#[derive(Serialize, Clone)]
struct ProfileDetection {
    path: String,
    profile: String,
    browser: String,
    is_default: bool,
    emails: Vec<String>,
}

fn chrome_time_to_iso(ts: i64) -> String {
    let epoch = NaiveDate::from_ymd_opt(1601, 1, 1)
        .unwrap()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    let dt = epoch + Duration::microseconds(ts);
    // The trailing Z matters: without it, JavaScript parses this UTC wall
    // time as LOCAL time, shifting every visit for non-UTC users.
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn copy_db(src: &str) -> Result<NamedTempFile, String> {
    let tmp = NamedTempFile::new().map_err(|e| e.to_string())?;
    fs::copy(src, tmp.path()).map_err(|e| e.to_string())?;
    Ok(tmp)
}

fn has_cluster_tables(conn: &Connection) -> bool {
    let mut stmt = conn
        .prepare("select name from sqlite_master where type='table'")
        .unwrap();
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let set: HashSet<_> = rows.into_iter().collect();
    set.contains("clusters") && set.contains("clusters_and_visits")
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.prepare("select 1 from sqlite_master where type='table' and name = ?1")
        .and_then(|mut s| s.exists([name]))
        .unwrap_or(false)
}

fn count_journeys(conn: &Connection) -> usize {
    // Prefer Chrome clusters if available, counting only clusters with at least 3 visits.
    if has_cluster_tables(conn) {
        let cluster_count: i64 = conn
            .prepare(
                "
                SELECT COUNT(*) FROM (
                  SELECT cluster_id, COUNT(*) AS c
                  FROM clusters_and_visits
                  GROUP BY cluster_id
                  HAVING c >= 3
                )
                ",
            )
            .and_then(|mut s| s.query_row([], |row| row.get(0)))
            .unwrap_or(0);
        if cluster_count > 0 {
            return cluster_count.max(0) as usize;
        }
    }

    // Heuristic grouping similar to frontend: group visits by <=30 minute gaps and require >=3 visits.
    let mut stmt = match conn.prepare("SELECT visit_time FROM visits ORDER BY visit_time ASC LIMIT 2000") {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let rows = stmt
        .query_map([], |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>();
    let times = match rows {
        Ok(v) => v,
        Err(_) => return 0,
    };
    if times.len() < 3 {
        return 0;
    }
    let mut clusters: Vec<usize> = vec![];
    let mut current = 1usize;
    let max_gap_us: i64 = 30 * 60 * 1_000_000;
    for i in 1..times.len() {
        let gap = times[i] - times[i - 1];
        if gap <= max_gap_us {
            current += 1;
        } else {
            if current >= 3 {
                clusters.push(current);
            }
            current = 1;
        }
    }
    if current >= 3 {
        clusters.push(current);
    }
    clusters.len()
}

fn journey_count_from_path(history_path: &Path) -> Result<usize, String> {
    if !history_path.exists() {
        return Ok(0);
    }
    let tmp = copy_db(&history_path.to_string_lossy())?;
    let conn = Connection::open(tmp.path()).map_err(|e| e.to_string())?;
    Ok(count_journeys(&conn))
}

fn read_json(path: &Path) -> Option<Value> {
    let body = fs::read_to_string(path).ok()?;
    serde_json::from_str(&body).ok()
}

fn default_profile_name(local_state: &Value) -> Option<String> {
    let profile = local_state.get("profile")?;
    if let Some(last_used) = profile.get("last_used").and_then(|v| v.as_str()) {
        return Some(last_used.to_string());
    }
    if let Some(active) = profile.get("active_profile").and_then(|v| v.as_str()) {
        return Some(active.to_string());
    }
    if let Some(arr) = profile.get("last_active_profiles").and_then(|v| v.as_array()) {
        if let Some(first) = arr.iter().filter_map(|v| v.as_str()).next() {
            return Some(first.to_string());
        }
    }
    None
}

fn collect_emails(value: &Value, emails: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let key_lower = k.to_ascii_lowercase();
                if key_lower.contains("email") {
                    if let Some(s) = v.as_str() {
                        if s.contains('@') {
                            emails.insert(s.to_string());
                        }
                    }
                }
                collect_emails(v, emails);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_emails(v, emails);
            }
        }
        _ => {}
    }
}

fn profile_emails(profile_name: &str, base_path: &Path, local_state: Option<&Value>) -> Vec<String> {
    let mut emails: HashSet<String> = HashSet::new();

    if let Some(ls) = local_state {
        if let Some(cache) = ls
            .get("profile")
            .and_then(|v| v.get("info_cache"))
            .and_then(|v| v.get(profile_name))
        {
            if let Some(s) = cache.get("user_email").and_then(|v| v.as_str()) {
                if s.contains('@') {
                    emails.insert(s.to_string());
                }
            }
            if let Some(s) = cache.get("email").and_then(|v| v.as_str()) {
                if s.contains('@') {
                    emails.insert(s.to_string());
                }
            }
            collect_emails(cache, &mut emails);
        }
    }

    let preferences_path = base_path.join(profile_name).join("Preferences");
    if let Some(prefs) = read_json(&preferences_path) {
        collect_emails(&prefs, &mut emails);
    }

    let mut list: Vec<String> = emails.into_iter().collect();
    list.sort();
    list
}

fn detect_from_base(base_path: &Path, browser: &str, output: &mut Vec<ProfileDetection>) {
    let local_state = read_json(&base_path.join("Local State"));
    let default_name = local_state.as_ref().and_then(|v| default_profile_name(v));
    let is_mac = cfg!(target_os = "macos");

    if let Ok(entries) = fs::read_dir(base_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("Profile") || name == "Default") {
                continue;
            }
            let history_path = base_path.join(&name).join("History");
            if !history_path.exists() {
                continue;
            }
            // Skip profiles that would not produce any journeys under our criteria.
            match journey_count_from_path(&history_path) {
                Ok(count) if count == 0 => continue,
                Err(_) => continue,
                _ => {}
            }
            let emails = profile_emails(&name, base_path, local_state.as_ref());
            let is_default = match &default_name {
                Some(def) => def == &name,
                None => name == "Default",
            };
            if is_mac && history_path.to_string_lossy().contains(".tmp") {
                continue;
            }
            output.push(ProfileDetection {
                path: history_path.to_string_lossy().to_string(),
                profile: name,
                browser: browser.to_string(),
                is_default,
                emails,
            });
        }
    }
}

#[tauri::command]
fn detect_history_profiles() -> Vec<ProfileDetection> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut profiles: Vec<ProfileDetection> = vec![];

    #[cfg(target_os = "macos")]
    {
        let bases = [
            ("Library/Application Support/Google/Chrome", "Chrome"),
            ("Library/Application Support/Google/Chrome Beta", "Chrome Beta"),
            ("Library/Application Support/Google/Chrome Canary", "Chrome Canary"),
            ("Library/Application Support/Chromium", "Chromium"),
            ("Library/Application Support/BraveSoftware/Brave-Browser", "Brave"),
        ];
        for (rel, browser) in bases {
            detect_from_base(&home.join(rel), browser, &mut profiles);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(local) = dirs::data_dir() {
            let bases = [
                ("Google/Chrome/User Data", "Chrome"),
                ("Google/Chrome Beta/User Data", "Chrome Beta"),
                ("Google/Chrome Dev/User Data", "Chrome Dev"),
                ("Google/Chrome SxS/User Data", "Chrome Canary"),
                ("Chromium/User Data", "Chromium"),
                ("BraveSoftware/Brave-Browser/User Data", "Brave"),
            ];
            for (rel, browser) in bases {
                detect_from_base(&local.join(rel), browser, &mut profiles);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let bases = [
            (".config/google-chrome", "Chrome"),
            (".config/google-chrome-beta", "Chrome Beta"),
            (".config/google-chrome-unstable", "Chrome Unstable"),
            (".config/chromium", "Chromium"),
            (".config/BraveSoftware/Brave-Browser", "Brave"),
        ];
        for (rel, browser) in bases {
            detect_from_base(&home.join(rel), browser, &mut profiles);
        }
    }

    profiles.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| a.browser.cmp(&b.browser))
            .then_with(|| a.profile.cmp(&b.profile))
    });
    profiles
}

// Not every Chromium-family History has keyword_search_terms; join only if present.
fn keyword_join(conn: &Connection) -> (&'static str, &'static str) {
    if has_table(conn, "keyword_search_terms") {
        (
            "IFNULL(k.term, '')",
            "LEFT JOIN (SELECT url_id, MAX(term) AS term FROM keyword_search_terms GROUP BY url_id) k ON k.url_id = v.url",
        )
    } else {
        ("''", "")
    }
}

#[tauri::command]
fn read_clusters(path: String, cluster_limit: Option<usize>) -> Result<Vec<Cluster>, String> {
    let tmp = copy_db(&path)?;
    let conn = Connection::open(tmp.path()).map_err(|e| e.to_string())?;
    if !has_cluster_tables(&conn) {
        return Err("no cluster tables".into());
    }
    let (kw_select, kw_join) = keyword_join(&conn);
    let mut sql = format!(
        "
      SELECT c.cluster_id, cav.visit_id, v.visit_time, u.url, u.title, {}
      FROM clusters c
      JOIN clusters_and_visits cav ON cav.cluster_id = c.cluster_id
      JOIN visits v ON v.id = cav.visit_id
      JOIN urls u ON u.id = v.url
      {}
      ORDER BY c.cluster_id DESC, v.visit_time
    ",
        kw_select, kw_join
    );
    if let Some(limit) = cluster_limit {
        sql = format!(
            "
            SELECT c.cluster_id, cav.visit_id, v.visit_time, u.url, u.title, {}
            FROM clusters c
            JOIN clusters_and_visits cav ON cav.cluster_id = c.cluster_id
            JOIN visits v ON v.id = cav.visit_id
            JOIN urls u ON u.id = v.url
            {}
            WHERE c.cluster_id IN (SELECT cluster_id FROM clusters ORDER BY cluster_id DESC LIMIT {})
            ORDER BY c.cluster_id DESC, v.visit_time
            ",
            kw_select, kw_join, limit
        );
    }
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let cid: i64 = row.get(0)?;
            let ts: i64 = row.get(2)?;
            let url: String = row.get(3)?;
            let title: String = row.get(4)?;
            let term: String = row.get(5)?;
            let parsed = Url::parse(&url).ok();
            Ok((
                cid,
                Visit {
                    id: row.get(1)?,
                    url: url.clone(),
                    title,
                    visited_at: chrome_time_to_iso(ts),
                    from_visit: 0,
                    domain: parsed
                        .and_then(|u| u.host_str().map(|s| s.to_string()))
                        .unwrap_or_default(),
                    search_term: term,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut clusters: Vec<Cluster> = vec![];
    let mut current: Option<i64> = None;
    let mut bucket: Vec<Visit> = vec![];
    for (cid, visit) in rows {
        if current.is_none() {
            current = Some(cid);
        }
        if Some(cid) != current {
            clusters.push(Cluster {
                cluster_id: current.unwrap(),
                visits: bucket,
            });
            bucket = vec![visit];
            current = Some(cid);
        } else {
            bucket.push(visit);
        }
    }
    if let Some(cid) = current {
        clusters.push(Cluster {
            cluster_id: cid,
            visits: bucket,
        });
    }
    Ok(clusters)
}

#[tauri::command]
fn read_visits(path: String, visit_limit: Option<usize>) -> Result<Vec<Visit>, String> {
    let tmp = copy_db(&path)?;
    let conn = Connection::open(tmp.path()).map_err(|e| e.to_string())?;
    let (kw_select, kw_join) = keyword_join(&conn);
    let mut sql = format!(
        "
      SELECT v.id, u.url, u.title, v.visit_time, v.from_visit, {}
      FROM visits v
      JOIN urls u ON u.id = v.url
      {}
      ORDER BY v.visit_time DESC
    ",
        kw_select, kw_join
    );
    if let Some(limit) = visit_limit {
        sql.push_str(&format!(" LIMIT {}", limit));
    }
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let url: String = row.get(1)?;
            let parsed = Url::parse(&url).ok();
            Ok(Visit {
                id: row.get(0)?,
                url: url.clone(),
                title: row.get(2)?,
                visited_at: chrome_time_to_iso(row.get(3)?),
                from_visit: row.get(4)?,
                domain: parsed
                    .and_then(|u| u.host_str().map(|s| s.to_string()))
                    .unwrap_or_default(),
                search_term: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// Generic presigned-POST upload: presign, then multipart-POST the JSON body
// exactly as provided (no wrapping). Returns the SHA-256 of the payload.
#[tauri::command]
fn upload_json(
    presign_endpoint: String,
    participant_id: String,
    study_id: Option<String>,
    task_id: String,
    filename: String,
    body: String,
) -> Result<String, String> {
    let client = Client::new();
    let presign_body = serde_json::json!({
        "participantId": participant_id,
        "studyId": study_id,
        "taskId": task_id,
        "filename": filename,
        "contentType": "application/json"
    });
    let presign_resp = client
        .post(&presign_endpoint)
        .json(&presign_body)
        .send()
        .map_err(|e| format!("presign request failed: {}", e))?;
    let presign_status = presign_resp.status();
    let presign_text = presign_resp.text().unwrap_or_default();
    if !presign_status.is_success() {
        return Err(format!("presign {}: {}", presign_status, presign_text.trim()));
    }
    let presign_json: Value =
        serde_json::from_str(&presign_text).map_err(|e| format!("presign parse error: {}", e))?;
    let url = presign_json
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "presign missing url".to_string())?;
    let fields = presign_json
        .get("fields")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "presign missing fields".to_string())?;

    let payload = body.into_bytes();

    let mut form = Form::new();
    for (k, v) in fields {
        if let Some(s) = v.as_str() {
            form = form.text(k.clone(), s.to_string());
        }
    }
    let part = Part::bytes(payload.clone())
        .file_name(filename)
        .mime_str("application/json")
        .map_err(|e| format!("mime err {}", e))?;
    form = form.part("file", part);

    let upload_resp = client
        .post(url)
        .multipart(form)
        .send()
        .map_err(|e| format!("upload failed: {}", e))?;
    let upload_status = upload_resp.status();
    let upload_text = upload_resp.text().unwrap_or_default();
    if !upload_status.is_success() {
        return Err(format!("upload {}: {}", upload_status, upload_text.trim()));
    }
    let mut hasher = Sha256::new();
    hasher.update(&payload);
    Ok(format!("{:x}", hasher.finalize()))
}

fn kv_path() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or_else(|| "data dir unavailable".to_string())?;
    let dir = base.join("apollo-v2");
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {}", e))?;
    Ok(dir.join("kv.json"))
}

fn read_kv() -> Result<HashMap<String, String>, String> {
    let path = kv_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read kv: {}", e))?;
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&raw).map_err(|e| format!("parse kv: {}", e))
}

#[tauri::command]
fn kv_get(key: String) -> Result<Option<String>, String> {
    Ok(read_kv()?.remove(&key))
}

#[tauri::command]
fn kv_set(key: String, value: String) -> Result<(), String> {
    let mut map = read_kv()?;
    map.insert(key, value);
    let path = kv_path()?;
    let body = serde_json::to_string_pretty(&map).map_err(|e| format!("serialize kv: {}", e))?;
    // Write-then-rename so a crash mid-write can't corrupt dedupe/quota state.
    let dir = path
        .parent()
        .ok_or_else(|| "kv dir unavailable".to_string())?;
    let tmp = NamedTempFile::new_in(dir).map_err(|e| format!("kv tempfile: {}", e))?;
    fs::write(tmp.path(), body).map_err(|e| format!("write kv: {}", e))?;
    tmp.persist(&path)
        .map_err(|e| format!("persist kv: {}", e))?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_history_profiles,
            read_clusters,
            read_visits,
            upload_json,
            kv_get,
            kv_set
        ])
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
