use actix_web::{web, App, HttpServer, Responder, HttpResponse};
use actix_cors::Cors;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
struct LikeEntry {
    project_id: String,
    likes: i32,
}

#[derive(Clone, Serialize, Deserialize)]
struct FingerPrintEntry {
    fingerprint: String,
    project_ids: Vec<String>,
}

struct AppState {
    like_table: Mutex<Vec<LikeEntry>>,
    distinguished_fingerprints: Mutex<Vec<FingerPrintEntry>>,
    last_write: Mutex<u64>,
}

const WRITE_AFTER_TIME: u64 = 10;

fn init_tables() -> AppState {
    let mut like_table = Vec::new();
    let mut distinguished_fingerprints = Vec::new();

    if let Ok(mut file) = File::open("./cache/likeTable.json") {
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        like_table = serde_json::from_str(&contents).unwrap_or_default();
    }

    if let Ok(mut file) = File::open("./cache/distinguishedFingerprints.json") {
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        distinguished_fingerprints = serde_json::from_str(&contents).unwrap_or_default();
    }

    AppState {
        like_table: Mutex::new(like_table),
        distinguished_fingerprints: Mutex::new(distinguished_fingerprints),
        last_write: Mutex::new(SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()),
    }
}

fn write_like_table(state: &AppState) {
    let like_table = state.like_table.lock().unwrap();
    let json = serde_json::to_string(&*like_table).unwrap();
    let mut file = File::create("./cache/likeTable.json").unwrap();
    file.write_all(json.as_bytes()).unwrap();

    let distinguished_fingerprints = state.distinguished_fingerprints.lock().unwrap();
    let json = serde_json::to_string(&*distinguished_fingerprints).unwrap();
    let mut file = File::create("./cache/distinguishedFingerprints.json").unwrap();
    file.write_all(json.as_bytes()).unwrap();
}

async fn get_glob_like_struct(data: web::Data<AppState>) -> impl Responder {
    let like_table = data.like_table.lock().unwrap();
    HttpResponse::Ok().json(&*like_table)
}

async fn post_new_like(
    data: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
    req: actix_web::HttpRequest,
) -> impl Responder {
    let project_id = query.get("project_id").unwrap();
    let fingerprint = format!("{}{}", query.get("fingerprint").unwrap(), req.peer_addr().unwrap());

    let mut distinguished_fingerprints = data.distinguished_fingerprints.lock().unwrap();
    if let Some(entry) = distinguished_fingerprints.iter_mut().find(|e| e.fingerprint == fingerprint) {
        entry.project_ids.push(project_id.to_string());
    } else {
        distinguished_fingerprints.push(FingerPrintEntry {
            fingerprint: fingerprint.clone(),
            project_ids: vec![project_id.to_string()],
        });
    }

    let mut like_table = data.like_table.lock().unwrap();
    if let Some(entry) = like_table.iter_mut().find(|e| e.project_id == *project_id) {
        entry.likes += 1;
    } else {
        like_table.push(LikeEntry {
            project_id: project_id.to_string(),
            likes: 1,
        });
    }

    let mut last_write = data.last_write.lock().unwrap();
    let current_time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    if current_time - *last_write > WRITE_AFTER_TIME {
        write_like_table(&data);
        *last_write = current_time;
    }

    HttpResponse::Ok().json(serde_json::json!({"status": "success"}))
}

async fn init_page_load(
    data: web::Data<AppState>,
    query: web::Query<HashMap<String, String>>,
    req: actix_web::HttpRequest,
) -> impl Responder {
    let fingerprint = format!("{}{}", query.get("fingerprint").unwrap(), req.peer_addr().unwrap());

    let distinguished_fingerprints = data.distinguished_fingerprints.lock().unwrap();
    if let Some(entry) = distinguished_fingerprints.iter().find(|e| e.fingerprint == fingerprint) {
        HttpResponse::Ok().json(&entry.project_ids)
    } else {
        HttpResponse::Ok().json::<Vec<String>>(vec![])
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let state = web::Data::new(init_tables());

    HttpServer::new(move || {
        App::new()
            .wrap(Cors::permissive())
            .app_data(state.clone())
            .route("/getGlobLikeStruct", web::get().to(get_glob_like_struct))
            .route("/postNewLike", web::get().to(post_new_like))
            .route("/initPageLoad", web::get().to(init_page_load))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}