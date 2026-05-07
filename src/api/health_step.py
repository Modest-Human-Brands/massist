from typing import Any

from motia import ApiRequest, ApiResponse, FlowContext, http

config = {
    "name": "HealthCheck",
    "description": "Return Health Status",
    "flows": ["health-check-flow"],
    "triggers": [
        http("GET", "/api/health"),
    ],
    "enqueues": [],
}


async def handler(request: ApiRequest[Any], ctx: FlowContext[Any]) -> ApiResponse[Any]:
    return ApiResponse(status=200, body={"status": "OK"})
