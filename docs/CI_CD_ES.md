# CI/CD de IntegrationHub

## Qué queda automatizado

Cada cambio enviado a `main` pasa por este orden:

1. GitHub instala exactamente las dependencias del archivo de bloqueo.
2. Ejecuta pruebas, revisión de TypeScript y compilación de producción.
3. AWS SAM valida y construye la infraestructura serverless.
4. GitHub solicita una credencial temporal a AWS mediante OIDC.
5. SAM actualiza únicamente el stack `integrationhub-demo`.
6. El pipeline consulta `/health`; esta lectura no crea pedidos ni intentos.
7. Render, configurado con `checksPass`, publica la consola web cuando los
   checks de GitHub terminan correctamente y valida `/` como health check.

Las pruebas que crean pedidos, reintentos o cierres siguen siendo manuales desde
la consola. Así se evita modificar datos y consumir tráfico AWS con cada commit.

## Preparación única de AWS

`infra/github-oidc.yaml` crea:

- el proveedor OIDC de GitHub, solo si la cuenta todavía no lo tiene;
- un bucket privado y cifrado para paquetes SAM, con limpieza a los 30 días;
- un rol temporal que solo puede asumir el repositorio y rama indicados;
- un rol de CloudFormation limitado a los servicios usados por IntegrationHub.

Antes de desplegarlo, obtén el sujeto exacto del repositorio. Los repositorios
recientes de GitHub incluyen los identificadores inmutables del propietario y
del repositorio en este valor.

```bash
owner_id="$(curl -fsSL https://api.github.com/users/LissLiddell | jq -r .id)"
repo_id="$(curl -fsSL https://api.github.com/repos/LissLiddell/IntegrationHub | jq -r .id)"
github_subject="repo:LissLiddell@${owner_id}/IntegrationHub@${repo_id}:ref:refs/heads/main"
```

Comprueba primero si el proveedor OIDC ya existe:

```bash
if aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):oidc-provider/token.actions.githubusercontent.com" \
  >/dev/null 2>&1; then
  create_provider=false
else
  create_provider=true
fi
```

Despliega el acceso inicial:

```bash
aws cloudformation deploy \
  --template-file infra/github-oidc.yaml \
  --stack-name integrationhub-github-delivery \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOidcSubject="$github_subject" \
    CreateGitHubOidcProvider="$create_provider"
```

Lee el ARN resultante:

```bash
aws cloudformation describe-stacks \
  --stack-name integrationhub-github-delivery \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='GitHubDeployRoleArn'].OutputValue | [0]" \
  --output text
```

En GitHub abre **Settings → Secrets and variables → Actions → Variables** y
crea `AWS_DEPLOY_ROLE_ARN` con ese ARN. No es una contraseña; identifica el rol
que GitHub puede solicitar temporalmente. Después ejecuta manualmente el workflow
**Quality and deploy** una vez. Los siguientes pushes a `main` recorrerán el
camino completo automáticamente.

## Barreras de seguridad

- GitHub no conserva una llave AWS permanente.
- El rol solo confía en `LissLiddell/IntegrationHub`, rama `main`, y en los IDs
  inmutables indicados al crear el stack.
- GitHub solo puede cargar artefactos, operar el stack de IntegrationHub y pasar
  el rol de ejecución específico a CloudFormation.
- CloudFormation administra recursos con el prefijo del stack y los servicios
  que la arquitectura necesita.
- `/health` no consulta Secrets Manager, no escribe DynamoDB y no publica SQS.
