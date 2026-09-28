use frameweaverd::{
    auth::{AuthRepository, AuthService, DiscordHttpClient, build_auth_router, protect_router},
    comfy::ComfyApi,
    config::AppConfig,
    fleet::{FleetStore, build_router as build_fleet_router},
    health::{AppState, build_router},
    jobs::{
        JobRepository,
        api::{build_routed_router as build_jobs_router, reconcile_incomplete_routed},
    },
    proxy::{ProxyConfig, build_router as build_proxy_router},
    static_files,
    workers::{WorkerRegistry, build_router as build_workers_router},
};
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = AppConfig::from_env()?;
    let database_path = database_path()?;
    let repository = JobRepository::open(&database_path).await?;
    let auth_key = config
        .auth()
        .enabled()
        .map(|auth| auth.session_secret().to_vec())
        .unwrap_or_else(|| rand::random::<[u8; 32]>().to_vec());
    let auth_repository = AuthRepository::open(&database_path, &auth_key).await?;
    let discord = match config.auth().enabled() {
        Some(auth) => DiscordHttpClient::new(auth)?,
        None => DiscordHttpClient::disabled()?,
    };
    let auth = AuthService::new(
        config.auth().clone(),
        auth_repository,
        std::sync::Arc::new(discord),
    );
    let comfy = ComfyApi::new(config.comfy_url().clone())?;
    let workers = WorkerRegistry::from_env_or_local(comfy.clone())?;
    let listener = TcpListener::bind(config.listen_addr()).await?;
    let recovery_repository = repository.clone();
    let recovery_workers = workers.clone();
    tokio::spawn(async move {
        match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            reconcile_incomplete_routed(&recovery_repository, &recovery_workers),
        )
        .await
        {
            Ok(Ok(())) => tracing::info!("startup reconciliation complete"),
            Ok(Err(error)) => tracing::warn!(%error, "startup reconciliation failed"),
            Err(error) => tracing::warn!(%error, "startup reconciliation timed out"),
        }
    });
    let fleet = FleetStore::production();
    fleet.start();
    info!(address = %config.listen_addr(), "frameweaverd listening");

    axum::serve(
        listener,
        build_router(AppState::new(config.clone(), true))
            .merge(build_auth_router(auth.clone()))
            .merge(protect_router(
                build_fleet_router(fleet)
                    .merge(build_workers_router(workers.clone()))
                    .merge(build_jobs_router(repository.clone(), workers.clone()))
                    .merge(build_proxy_router(
                        ProxyConfig::new(
                            config.comfy_url().clone(),
                            std::time::Duration::from_secs(30),
                        )
                        .with_job_routing(repository, workers),
                    )),
                auth,
            ))
            .fallback_service(static_files::build_router(std::path::PathBuf::from("dist"))),
    )
    .with_graceful_shutdown(wait_for_shutdown())
    .await?;
    info!("frameweaverd stopped");
    Ok(())
}

fn database_path() -> Result<std::path::PathBuf, std::io::Error> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let directory = base.join("FrameWeaver");
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("frameweaver.db"))
}

async fn wait_for_shutdown() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl-C signal handler");
    info!("shutdown signal received");
}
