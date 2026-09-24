from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.network import APIGateway, CloudFront
from diagrams.aws.storage import S3
from diagrams.aws.management import SystemsManagerParameterStore, Cloudwatch
from diagrams.aws.security import Cognito, IAMRole
from diagrams.aws.general import Client
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.iac import Terraform

# ── Cost Breakdown ──────────────────────────────────────────────────
COST_LABEL = (
    "Nearby Friends MVP — AWS Architecture  |  Estimated Monthly Cost: ~$5–10\n"
    "─────────────────────────────────────────────────────────────────────\n"
    "Lambda × 3 (256 MB, no VPC):  ~$1–3\n"
    "DynamoDB × 4 (on-demand, pay-per-request):  ~$2–5\n"
    "API Gateway v2 (WebSocket + HTTP):  ~$1–3\n"
    "CloudWatch (logs + alarms):  ~$1–2\n"
    "S3 × 2 (profile pictures + frontend):  < $1\n"
    "Cognito (up to 50k MAUs):  free\n"
    "CloudFront (free tier):  free\n"
    "SSM Parameter Store (standard):  free\n"
    "─────────────────────────────────────────────────────────────────────\n"
    "No VPC  |  No NAT Gateway  |  No ElastiCache Redis"
)

graph_attr = {
    "fontsize": "10",
    "bgcolor": "white",
    "pad": "1.0",
    "nodesep": "0.6",
    "ranksep": "1.0",
    "label": COST_LABEL,
    "labelloc": "b",
    "fontname": "Courier",
}

with Diagram(
    "",
    filename="generated-diagrams/Friend-finder_MVP",
    show=False,
    direction="TB",
    graph_attr=graph_attr,
    outformat="png",
):

    # ── External Clients ────────────────────────────────────────────
    browser = Client("Browser")
    mobile  = Client("Mobile App")

    # ── Auth ────────────────────────────────────────────────────────
    cognito = Cognito(
        "Cognito\n"
        "User Pool\n"
        "Hosted UI (web)\n"
        "SDK (mobile)\n"
        "JWT issuer"
    )

    # ── Frontend ────────────────────────────────────────────────────
    with Cluster("Frontend"):
        cf  = CloudFront("CloudFront\nHTTPS delivery")
        s3f = S3("S3\nfrontend bucket\nindex.html")
        cf >> s3f

    # ── API Gateway Layer ───────────────────────────────────────────
    with Cluster("API Gateway v2"):
        ws_api = APIGateway(
            "WebSocket API\n"
            "$connect (JWKS verify)\n"
            "$disconnect\n"
            "location.update"
        )
        http_api = APIGateway(
            "HTTP API\n"
            "JWT Authorizer → Cognito\n"
            "DELETE /friends/{friendId}\n"
            "GET/PUT /users/profile\n"
            "GET /nearby-strangers\n"
            "POST/GET/PUT /friend-requests\n"
            "GET /profile-picture-upload-url"
        )

    # ── Lambda Handlers ─────────────────────────────────────────────
    with Cluster("Lambda Handlers (3 functions, no VPC)"):
        lam_ws = Lambda(
            "websocket-handler\n"
            "$connect · $disconnect\n"
            "location.update"
        )
        lam_rest = Lambda(
            "rest-handler\n"
            "All REST routes"
        )
        lam_fanout = Lambda(
            "fanout-handler\n"
            "DynamoDB Streams\n"
            "→ push to friends"
        )

    # ── DynamoDB Tables ─────────────────────────────────────────────
    with Cluster("DynamoDB (on-demand)  ~$2–5/mo"):
        ddb_conn = Dynamodb(
            "Connections\n"
            "PK: connectionId\n"
            "GSI: userId\n"
            "TTL: expiresAt\n"
            "+ location data\n"
            "+ DynamoDB Stream"
        )
        ddb_friends = Dynamodb(
            "Friendships\n"
            "PK: userId\n"
            "SK: friendId\n"
            "GSI: friendId"
        )
        ddb_users = Dynamodb(
            "Users\n"
            "PK: userId\n"
            "displayName\n"
            "discoverable"
        )
        ddb_requests = Dynamodb(
            "FriendRequests\n"
            "PK: requestId\n"
            "GSI: toUserId\n"
            "GSI: fromUserId"
        )

    # ── Supporting Services ─────────────────────────────────────────
    s3 = S3(
        "S3 Bucket\n"
        "Profile Pictures\n"
        "SSE-S3 Encryption"
    )
    ssm = SystemsManagerParameterStore(
        "SSM Parameter Store\n"
        "/nearby-friends/*\n"
        "radius · TTL · interval\n"
        "max-friends · strangers-limit"
    )
    cw = Cloudwatch(
        "CloudWatch\n"
        "3 Log Groups\n"
        "Per-Lambda Alarms"
    )

    # ── CI/CD Pipeline ──────────────────────────────────────────────
    with Cluster("CI/CD — deploy on push to main"):
        gha = GithubActions(
            "GitHub Actions\n"
            "push → main\n"
            "build Lambda zips"
        )
        deploy_role = IAMRole(
            "IAM Role\n"
            "github-actions-deploy\n"
            "assumed via OIDC\n"
            "(no static keys)"
        )
        tf = Terraform(
            "Terraform\n"
            "init + apply"
        )
        tf_state = S3(
            "S3\n"
            "remote state bucket\n"
            "versioned + encrypted"
        )
        tf_lock = Dynamodb(
            "DynamoDB\n"
            "state lock table"
        )

        gha >> Edge(label="assume role", style="dashed", color="darkorange") >> deploy_role
        gha >> Edge(color="black") >> tf
        tf  >> Edge(label="state", style="dashed", color="royalblue") >> tf_state
        tf  >> Edge(label="lock", style="dashed", color="royalblue") >> tf_lock

    # ════════════════════════════════════════════════════════════════
    # EDGES
    # ════════════════════════════════════════════════════════════════

    # Browser → Cognito hosted UI → frontend
    browser >> Edge(label="sign up/in", color="darkorange") >> cognito
    browser >> Edge(label="https://", color="darkgreen") >> cf

    # Mobile → Cognito SDK
    mobile >> Edge(label="SRP/password auth", color="darkorange") >> cognito

    # Cognito issues JWT → clients use it on API calls
    cognito >> Edge(label="id_token (JWT)", style="dashed", color="darkorange") >> browser
    cognito >> Edge(label="id_token (JWT)", style="dashed", color="darkorange") >> mobile

    # Client → API Gateway
    browser >> Edge(label="wss://?token=JWT", color="darkblue", style="bold") >> ws_api
    browser >> Edge(label="Authorization: Bearer JWT", color="darkgreen", style="bold") >> http_api
    mobile  >> Edge(label="wss://?token=JWT", color="darkblue", style="bold") >> ws_api
    mobile  >> Edge(label="Authorization: Bearer JWT", color="darkgreen", style="bold") >> http_api

    # HTTP API validates JWT against Cognito
    http_api >> Edge(label="validate JWT", style="dashed", color="darkorange") >> cognito

    # API Gateway → Lambda handlers
    ws_api   >> Edge(color="darkblue")  >> lam_ws
    http_api >> Edge(color="darkgreen") >> lam_rest

    # DynamoDB Streams → fanout-handler
    ddb_conn >> Edge(
        label="DynamoDB Stream\n(MODIFY events)", style="dashed", color="orange"
    ) >> lam_fanout

    # fanout-handler → push back through WebSocket API
    lam_fanout >> Edge(
        label="PostToConnection", style="dashed", color="purple"
    ) >> ws_api

    # websocket-handler → DynamoDB
    lam_ws >> Edge(color="royalblue") >> ddb_conn
    lam_ws >> Edge(color="royalblue") >> ddb_friends

    # rest-handler → DynamoDB
    lam_rest >> Edge(color="royalblue") >> ddb_friends
    lam_rest >> Edge(color="royalblue") >> ddb_users
    lam_rest >> Edge(color="royalblue") >> ddb_requests
    lam_rest >> Edge(color="royalblue") >> ddb_conn

    # fanout-handler → DynamoDB
    lam_fanout >> Edge(color="royalblue") >> ddb_friends
    lam_fanout >> Edge(color="royalblue") >> ddb_conn

    # Lambda → S3 profile pictures (pre-signed URLs)
    lam_rest >> Edge(label="pre-signed\nGET/PUT", color="sienna") >> s3

    # Lambda → SSM (config reads)
    lam_ws     >> Edge(style="dotted", color="gray") >> ssm
    lam_rest   >> Edge(style="dotted", color="gray") >> ssm
    lam_fanout >> Edge(style="dotted", color="gray") >> ssm

    # Lambda → CloudWatch (logging)
    lam_ws     >> Edge(style="dotted", color="gray") >> cw
    lam_rest   >> Edge(style="dotted", color="gray") >> cw
    lam_fanout >> Edge(style="dotted", color="gray") >> cw

    # CI/CD → provisions / updates the whole stack
    tf >> Edge(
        label="terraform apply\nprovisions all resources", style="dotted", color="darkgreen"
    ) >> lam_rest
