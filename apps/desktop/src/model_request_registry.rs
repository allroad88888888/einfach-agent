use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/** Tracks cancellable native model requests by their renderer-provided ID. */
#[derive(Default)]
pub struct ModelRequestCanceller {
    requests: Mutex<HashMap<String, CancellationToken>>,
}

impl ModelRequestCanceller {
    pub fn register(&self, request_id: &str) -> Result<CancellationToken, String> {
        valid_request_id(request_id)?;
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| "模型请求取消状态不可用".to_string())?;
        if requests.contains_key(request_id) {
            return Err("模型请求 ID 已存在".to_string());
        }
        let token = CancellationToken::new();
        requests.insert(request_id.to_string(), token.clone());
        Ok(token)
    }

    pub fn cancel(&self, request_id: &str) -> Result<bool, String> {
        valid_request_id(request_id)?;
        let token = self
            .requests
            .lock()
            .map_err(|_| "模型请求取消状态不可用".to_string())?
            .get(request_id)
            .cloned();
        if let Some(token) = token {
            token.cancel();
            return Ok(true);
        }
        Ok(false)
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }
}

fn valid_request_id(request_id: &str) -> Result<(), String> {
    let is_valid = !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    is_valid
        .then_some(())
        .ok_or_else(|| "模型请求 ID 无效".to_string())
}

#[cfg(test)]
mod tests {
    use super::ModelRequestCanceller;

    #[test]
    fn rejects_invalid_request_ids() {
        let canceller = ModelRequestCanceller::default();

        assert!(canceller.register("").is_err());
        assert!(canceller.register("request with spaces").is_err());
        assert!(canceller.register(&"r".repeat(129)).is_err());
    }

    #[test]
    fn cancellation_is_scoped_to_one_active_request() {
        let canceller = ModelRequestCanceller::default();
        let request = canceller.register("request-1").expect("register request");
        let other_request = canceller
            .register("request-2")
            .expect("register other request");

        assert!(canceller.cancel("request-1").expect("cancel request"));
        assert!(request.is_cancelled());
        assert!(!other_request.is_cancelled());
        assert!(!canceller
            .cancel("missing-request")
            .expect("ignore missing request"));
        assert!(canceller.register("request-2").is_err());

        canceller.finish("request-1");
        assert!(canceller.register("request-1").is_ok());
    }
}
