// Infrastructure files: Dockerfile, Docker Compose, Terraform and Kubernetes manifests.
// Detection, file templates ("Novo" menu) and actions that run the real CLIs in the Terminal
// (docker, docker compose, terraform, kubectl). Language servers live in lsp.ts.
import { confirmDialog, promptDialog, type MenuItem } from "../ui";
import { IS_WIN, P } from "./host";
import type { Workbench } from "./workbench";

export type InfraKind = "dockerfile" | "compose" | "terraform" | "k8s";

const COMPOSE_RE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;

/** Kind of infrastructure file; YAML needs the text to tell Kubernetes manifests apart. */
export function infraKind(path: string, text?: string): InfraKind | null {
  const base = P.base(path).toLowerCase();
  if (base === "dockerfile" || base === "containerfile" || base.endsWith(".dockerfile") || base.startsWith("dockerfile.")) return "dockerfile";
  if (COMPOSE_RE.test(base)) return "compose";
  const ext = P.ext(path);
  if (ext === "tf" || ext === "tfvars" || base.endsWith(".tf.json")) return "terraform";
  if ((ext === "yaml" || ext === "yml") && text !== undefined && isK8s(text)) return "k8s";
  return null;
}

export function isK8s(text: string) {
  return /^apiVersion:\s*\S+/m.test(text) && /^kind:\s*[A-Z]\w+/m.test(text);
}

export const INFRA_LABEL: Record<InfraKind, string> = { dockerfile: "Dockerfile", compose: "Docker Compose", terraform: "Terraform", k8s: "Kubernetes" };
export const INFRA_ICON: Record<InfraKind, string> = { dockerfile: "docker", compose: "containerStack", terraform: "terraform", k8s: "k8s" };

const q = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** "a && b" for the terminal shell: Windows PowerShell 5.1 has no && (nor < redirection). */
const then = (a: string, b: string) => (IS_WIN ? `${a}; if ($?) { ${b} }` : `${a} && ${b}`);

function term(wb: Workbench, cwd: string, command: string) {
  wb.show("terminal");
  wb.terminals.newTab(cwd, command);
}

/** Actions for the editor bar, the editor context menu and the project tree. */
export function infraActions(wb: Workbench, path: string, kind: InfraKind): (MenuItem & { primary?: boolean })[] {
  const dir = P.dir(path);
  const file = q(P.base(path));
  switch (kind) {
    case "compose": {
      const f = `docker compose -f ${file}`;
      return [
        { label: "Subir (up -d)", icon: "run/run", primary: true, action: () => term(wb, dir, `${f} up -d`) },
        { label: "Subir com build", icon: "run/rerun", action: () => term(wb, dir, `${f} up -d --build`) },
        { label: "Parar e remover (down)", icon: "run/stop", primary: true, action: () => term(wb, dir, `${f} down`) },
        { label: "Status (ps)", icon: "toolwindows/services", action: () => term(wb, dir, `${f} ps`) },
        { label: "Logs", icon: "log", primary: true, action: () => term(wb, dir, `${f} logs -f --tail 200`) },
        { label: "Baixar imagens (pull)", icon: "general/download", action: () => term(wb, dir, `${f} pull`) },
        { label: "Validar (config)", icon: "actions/checked", action: () => term(wb, dir, then(`${f} config --quiet`, `echo "compose válido"`)) },
        ...(wb.docker ? [{ separator: true } as MenuItem, { label: "Abrir janela Docker", icon: "docker", action: () => wb.show("docker", true) }] : []),
      ];
    }
    case "dockerfile":
      return [
        {
          label: "Build da imagem…",
          icon: "run/run",
          primary: true,
          action: async () => {
            const tag = await promptDialog("Build da imagem", "Nome:tag da imagem", P.base(wb.root).toLowerCase().replace(/[^a-z0-9._-]/g, "-") + ":dev");
            if (tag) term(wb, dir, `docker build -f ${file} -t ${q(tag)} .`);
          },
        },
        {
          label: "Build e executar…",
          icon: "run/rerun",
          action: async () => {
            const tag = await promptDialog("Build e executar", "Nome:tag da imagem", P.base(wb.root).toLowerCase().replace(/[^a-z0-9._-]/g, "-") + ":dev");
            if (tag) term(wb, dir, then(`docker build -f ${file} -t ${q(tag)} .`, `docker run --rm -it ${q(tag)}`));
          },
        },
        { label: "Analisar com hadolint", icon: "general/show", action: () => term(wb, dir, IS_WIN ? `Get-Content ${file} | docker run --rm -i hadolint/hadolint` : `docker run --rm -i hadolint/hadolint < ${file}`) },
      ];
    case "terraform":
      return [
        { label: "init", icon: "general/download", action: () => term(wb, dir, "terraform init") },
        { label: "plan", icon: "run/run", primary: true, action: () => term(wb, dir, "terraform plan") },
        {
          label: "apply…",
          icon: "run/rerun",
          primary: true,
          action: async () => {
            if (await confirmDialog("terraform apply", `Aplicar o plano em ${P.rel(wb.root, dir) || "."}? O Terraform ainda pede confirmação no terminal.`, "Abrir apply")) term(wb, dir, "terraform apply");
          },
        },
        { label: "validate", icon: "actions/checked", primary: true, action: () => term(wb, dir, "terraform validate") },
        { label: "fmt", icon: "actions/reformatCode", action: () => term(wb, dir, "terraform fmt -recursive") },
        { label: "output", icon: "log", action: () => term(wb, dir, "terraform output") },
        { separator: true },
        {
          label: "destroy…",
          icon: "general/delete",
          danger: true,
          action: async () => {
            if (await confirmDialog("terraform destroy", "Destruir TODOS os recursos deste módulo? O Terraform ainda pede confirmação no terminal.", "Abrir destroy", true)) term(wb, dir, "terraform destroy");
          },
        },
      ];
    case "k8s":
      return [
        { label: "Aplicar (apply)", icon: "run/run", primary: true, action: () => term(wb, dir, `kubectl apply -f ${file}`) },
        { label: "Diferenças (diff)", icon: "vcs/diff", primary: true, action: () => term(wb, dir, `kubectl diff -f ${file}`) },
        { label: "Validar (dry-run)", icon: "actions/checked", action: () => term(wb, dir, `kubectl apply --dry-run=client -f ${file}`) },
        { label: "Status (get)", icon: "toolwindows/services", primary: true, action: () => term(wb, dir, `kubectl get -f ${file} -o wide`) },
        { label: "Contexto atual", icon: "general/settings", action: () => term(wb, dir, "kubectl config get-contexts") },
        { separator: true },
        {
          label: "Remover (delete)…",
          icon: "general/delete",
          danger: true,
          action: async () => {
            if (await confirmDialog("kubectl delete", `Remover do cluster os recursos de ${P.base(path)}?`, "Remover", true)) term(wb, dir, `kubectl delete -f ${file}`);
          },
        },
      ];
  }
}

// ---------------- templates ----------------

export interface InfraTemplate {
  label: string;
  icon: string;
  files: (dir: string) => { path: string; content: string }[];
}

export const INFRA_TEMPLATES: InfraTemplate[] = [
  {
    label: "Dockerfile",
    icon: "docker",
    files: (dir) => [
      {
        path: P.join(dir, "Dockerfile"),
        content: `# syntax=docker/dockerfile:1
FROM python:3.13-slim AS base

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Rode como usuário sem privilégios
RUN useradd --create-home app
USER app

EXPOSE 8000
CMD ["python", "main.py"]
`,
      },
      { path: P.join(dir, ".dockerignore"), content: `.git\n.venv\nvenv\n__pycache__\n*.pyc\nnode_modules\n.env\n.idea\n.vscode\n` },
    ],
  },
  {
    label: "Dockerfile (Go, multi-stage)",
    icon: "docker",
    files: (dir) => [
      {
        path: P.join(dir, "Dockerfile"),
        content: `# syntax=docker/dockerfile:1
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/app /app
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app"]
`,
      },
      { path: P.join(dir, ".dockerignore"), content: `.git\nbin\n*.test\n.env\n.idea\n.vscode\n` },
    ],
  },
  {
    label: "docker-compose.yml",
    icon: "containerStack",
    files: (dir) => [
      {
        path: P.join(dir, "compose.yaml"),
        content: `services:
  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgresql://app:app@db:5432/app
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:17
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10

volumes:
  db-data:
`,
      },
    ],
  },
  {
    label: "Terraform (módulo)",
    icon: "terraform",
    files: (dir) => [
      {
        path: P.join(dir, "main.tf"),
        content: `terraform {
  required_version = ">= 1.6"

  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

provider "docker" {}

resource "docker_image" "app" {
  name         = var.image
  keep_locally = true
}

resource "docker_container" "app" {
  name  = "\${var.name}-app"
  image = docker_image.app.image_id

  ports {
    internal = 80
    external = var.port
  }
}
`,
      },
      {
        path: P.join(dir, "variables.tf"),
        content: `variable "name" {
  description = "Prefixo dos recursos"
  type        = string
  default     = "rits"
}

variable "image" {
  description = "Imagem do container"
  type        = string
  default     = "nginx:alpine"
}

variable "port" {
  description = "Porta publicada no host"
  type        = number
  default     = 8080
}
`,
      },
      {
        path: P.join(dir, "outputs.tf"),
        content: `output "url" {
  description = "Endereço da aplicação"
  value       = "http://localhost:\${var.port}"
}
`,
      },
    ],
  },
  {
    label: "Kubernetes (Deployment + Service)",
    icon: "k8s",
    files: (dir) => [
      {
        path: P.join(dir, "k8s", "app.yaml"),
        content: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  labels:
    app: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
        - name: app
          image: nginx:alpine
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /
              port: 80
---
apiVersion: v1
kind: Service
metadata:
  name: app
spec:
  selector:
    app: app
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP
`,
      },
    ],
  },
];
