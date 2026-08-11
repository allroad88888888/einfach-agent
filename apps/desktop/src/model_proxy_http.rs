use crate::model_credentials::active_model_credential;
use crate::model_provider_route::{ProviderMethod, ResolvedProviderTarget};
use crate::model_proxy::ModelProxyEvent;
use crate::model_proxy_body::PreparedProviderBody;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER};
use tauri::{ipc::Channel, AppHandle};
use tokio_util::sync::CancellationToken;

const MODEL_REQUEST_TIMEOUT_SECONDS: u64 = 120;

pub(crate) fn model_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(
            MODEL_REQUEST_TIMEOUT_SECONDS,
        ))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化模型网络连接".to_string())
}

fn request_builder(
    client: &reqwest::Client,
    target: &ResolvedProviderTarget,
    api_key: &str,
    body: PreparedProviderBody,
) -> reqwest::RequestBuilder {
    let request = match target.method {
        ProviderMethod::Post => client.post(&target.url),
        ProviderMethod::Delete => client.delete(&target.url),
    }
    .header(AUTHORIZATION, format!("Bearer {api_key}"))
    .header(ACCEPT, "application/json, text/event-stream");
    match body {
        PreparedProviderBody::None => request,
        PreparedProviderBody::Json(json) => {
            request.header(CONTENT_TYPE, "application/json").body(json)
        }
        PreparedProviderBody::Multipart(form) => request.multipart(form),
    }
}

fn response_header(
    response: &reqwest::Response,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn declared_response_too_large(response: &reqwest::Response, limit: usize) -> bool {
    response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|length| length > limit as u64)
}

async fn stream_response(
    response: reqwest::Response,
    limit: usize,
    events: &Channel<ModelProxyEvent>,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let mut total_bytes = 0_usize;
    let mut chunks = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Ok(()),
            chunk = chunks.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = events.send(ModelProxyEvent::Error {
                    message: "模型响应中断".to_string(),
                });
                return Ok(());
            }
        };
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > limit {
            let _ = events.send(ModelProxyEvent::Error {
                message: "模型响应过大".to_string(),
            });
            return Ok(());
        }
        events
            .send(ModelProxyEvent::Chunk {
                bytes: bytes.to_vec(),
            })
            .map_err(|_| "模型响应通道已关闭")?;
    }
    events
        .send(ModelProxyEvent::End)
        .map_err(|_| "模型响应通道已关闭".to_string())
}

pub async fn send_provider_request(
    app: &AppHandle,
    target: ResolvedProviderTarget,
    body: PreparedProviderBody,
    events: &Channel<ModelProxyEvent>,
    cancellation: &CancellationToken,
) -> Result<(), String> {
    let credential = tokio::select! {
        _ = cancellation.cancelled() => return Ok(()),
        credential = active_model_credential(app, target.provider, target.scope) => credential?,
    };
    let client = model_http_client()?;
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Ok(()),
        response = request_builder(&client, &target, &credential.0, body).send() => {
            response.map_err(|_| "模型服务请求失败".to_string())?
        },
    };
    if declared_response_too_large(&response, target.max_response_bytes) {
        return Err("模型响应过大".to_string());
    }
    events
        .send(ModelProxyEvent::Response {
            status: response.status().as_u16(),
            content_type: response_header(&response, CONTENT_TYPE),
            retry_after: response_header(&response, RETRY_AFTER),
        })
        .map_err(|_| "模型响应通道已关闭".to_string())?;
    stream_response(response, target.max_response_bytes, events, cancellation).await
}

#[cfg(test)]
mod tests {
    use super::model_http_client;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn model_client_does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind redirect server");
        let address = listener.local_addr().expect("read redirect server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept model request");
            let mut request = [0_u8; 1_024];
            stream.read(&mut request).expect("read model request");
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .expect("write redirect response");
        });
        let response = tauri::async_runtime::block_on(async {
            model_http_client()
                .expect("build model client")
                .post(format!("http://{address}/chat/completions"))
                .body("{}")
                .send()
                .await
        })
        .expect("return redirect response without following it");
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        server.join().expect("finish redirect server");
    }
}
