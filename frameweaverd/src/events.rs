use std::time::Duration;

pub struct OperationEvent<'a> {
    event: &'static str,
    job_id: Option<&'a str>,
    owner_id: Option<&'a str>,
    from: Option<&'a str>,
    to: Option<&'a str>,
    result: &'a str,
    duration: Duration,
}

impl<'a> OperationEvent<'a> {
    pub fn new(event: &'static str, result: &'a str, duration: Duration) -> Self {
        Self {
            event,
            job_id: None,
            owner_id: None,
            from: None,
            to: None,
            result,
            duration,
        }
    }

    pub fn job_id(mut self, job_id: &'a str) -> Self {
        self.job_id = Some(job_id);
        self
    }

    pub fn owner_id(mut self, owner_id: &'a str) -> Self {
        self.owner_id = Some(owner_id);
        self
    }

    pub fn transition(mut self, from: &'a str, to: &'a str) -> Self {
        self.from = Some(from);
        self.to = Some(to);
        self
    }

    pub fn info(self) {
        self.emit(false);
    }

    pub fn warn(self) {
        self.emit(true);
    }

    fn emit(self, warning: bool) {
        let owner_short = self
            .owner_id
            .map(|owner| owner.chars().take(8).collect::<String>())
            .unwrap_or_default();
        let job_id = self.job_id.unwrap_or_default();
        let from = self.from.unwrap_or_default();
        let to = self.to.unwrap_or_default();
        let duration_ms = u64::try_from(self.duration.as_millis()).unwrap_or(u64::MAX);
        if warning {
            tracing::warn!(
                event = self.event,
                job_id,
                owner_short,
                from,
                to,
                result = self.result,
                duration_ms,
                "frameweaver operation"
            );
        } else {
            tracing::info!(
                event = self.event,
                job_id,
                owner_short,
                from,
                to,
                result = self.result,
                duration_ms,
                "frameweaver operation"
            );
        }
    }
}
