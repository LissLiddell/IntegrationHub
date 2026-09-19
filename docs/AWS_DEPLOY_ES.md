# Conectar IntegrationHub con AWS

Esta etapa cambia la consola de **vista local** a **conectada**. Desde ese
momento, los roles, las correcciones de conexión, los cierres y su actividad de
auditoría quedan guardados en DynamoDB y sobreviven a una recarga del navegador.

## Antes de comenzar

Se necesitan AWS CLI y AWS SAM CLI instalados, una sesión de AWS iniciada y
Node.js 20 o posterior. Para una demo de portafolio conviene usar una sola
región, por ejemplo `us-east-1`, y borrar la pila cuando deje de utilizarse.

## 1. Generar las llaves privadas de la demo

Desde la carpeta `integrationhub`:

```powershell
pnpm demo:credentials
```

Guarda en un lugar privado los tres valores impresos. No subas ninguno a Git:

- `DEMO_CONTROL_KEY`: la llave que usará el servidor web.
- `DEMO_ACCESS_KEY_SHA256`: sólo este hash se entrega a CloudFormation.
- `DEMO_WEBHOOK_TOKEN`: identifica el webhook de la demostración.

## 2. Construir y desplegar la pila

```powershell
sam build --template-file infra/template.yaml
sam deploy --guided
```

En el asistente usa:

- Stack name: `integrationhub-demo`
- AWS Region: `us-east-1`
- Parameter `DemoAccessKeySha256`: el valor generado en el paso anterior
- Parameter `DemoValidCredential`: conserva el valor ficticio predeterminado
  para que la guía interactiva pueda completar el escenario `401`
- Confirm changes before deploy: `Y`
- Allow SAM CLI IAM role creation: `Y`
- Save arguments to configuration file: `Y`

Al terminar, conserva estos outputs: `WebhookApiUrl`,
`IntegrationTableName`, `DemoDestinationUrl`, `DemoDestinationSecretArn` y
`ControlApiUrl`.

## 3. Sembrar Nébula Commerce y los roles

En la misma ventana de PowerShell asigna los outputs y el token que guardaste:

```powershell
$env:AWS_REGION = "us-east-1"
$env:INTEGRATION_TABLE_NAME = "<IntegrationTableName>"
$env:DEMO_DESTINATION_URL = "<DemoDestinationUrl>"
$env:DEMO_DESTINATION_SECRET_ARN = "<DemoDestinationSecretArn>"
$env:DEMO_API_BASE_URL = "<WebhookApiUrl>"
$env:DEMO_WEBHOOK_TOKEN = "<DEMO_WEBHOOK_TOKEN>"
pnpm seed:aws-demo
```

El seed puede repetirse después de actualizar la pila. También crea la
asignación de `user_lisset` con los tres perfiles de la demo.

## 4. Conectar la consola web

Crea `apps/web/.env.local` a partir de `apps/web/.env.example` y coloca:

```text
INTEGRATIONHUB_API_URL=<ControlApiUrl>
INTEGRATIONHUB_DEMO_KEY=<DEMO_CONTROL_KEY>
```

Después inicia la consola:

```powershell
pnpm dev:web
```

El encabezado debe mostrar **Conectado a AWS**. Al corregir una conexión o
cerrar un caso, recarga la página: el cambio debe seguir ahí.

## 5. Probar el laboratorio AWS

1. Abre **Laboratorio AWS** y ejecuta **Éxito al primer intento**. Debe terminar
   en `202` con un solo intento.
2. Ejecuta **Fallo temporal**. Debe terminar en `503`; reprocesarlo como
   Operadora debe agregar el intento 2 con `202`.
3. Ejecuta **Credencial rechazada**. El intento 1 debe terminar en `401` y no
   permitir un reintento ciego.
4. Cambia al perfil **Administradora**, abre **Corregir conexión** y pulsa
   **Cargar clave demo**. **Guardar y probar conexión** debe registrar la
   actividad sin crear otro intento del pedido.
5. Cambia a **Operadora** y pulsa **Reprocesar pedido**. Ésta sí es una petición
   real y debe quedar como intento 2 con `202`.
6. Genera otro fallo, ciérralo con **Otro motivo** y escribe su historia.
7. Recarga el navegador y confirma que el cierre y las actividades permanecen.
8. Cambia a **Auditora** y confirma que puede leer, pero no modificar.

La clave `nebula-portfolio-demo-2026` es pública y ficticia: no permite entrar
a AWS ni acceder a datos. Secrets Manager conserva únicamente la copia cliente
que usa IntegrationHub; el proveedor de laboratorio compara contra un valor
independiente. Así el `401` y su corrección son reales sin exponer credenciales
productivas.

## Apagar la demostración

Cuando ya no quieras conservar los recursos:

```powershell
sam delete --stack-name integrationhub-demo --region us-east-1
```

La plantilla usa DynamoDB bajo demanda, evita recuperación histórica y trazas
pagadas, y limita la concurrencia. Aun así, AWS puede cobrar por consumo y el
secreto administrado tiene costo propio; revisa Billing y configura un aviso de
presupuesto antes de dejar la demo pública.
