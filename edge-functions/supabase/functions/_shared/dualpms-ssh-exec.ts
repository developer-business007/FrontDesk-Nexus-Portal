import { Client, type ConnectConfig } from "npm:ssh2@1.16.0";
import type { DualPmsSshConfig } from "./dualpms-secrets.ts";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run read-only SQL on the VPS via `sudo -u postgres psql` (peer auth). */
export function execDualPmsPsql(config: DualPmsSshConfig, sql: string): Promise<string> {
  const db = config.database?.trim() || "hotel";
  const remoteCmd = `sudo -u postgres psql -d ${shellQuote(db)} -t -A -c ${shellQuote(sql)}`;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn.on("ready", () => {
      conn.exec(remoteCmd, (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }
        stream
          .on("close", (code: number) => {
            conn.end();
            if (code !== 0) {
              reject(new Error(stderr.trim() || `Remote psql exited with code ${code}`));
              return;
            }
            resolve(stdout.trim());
          })
          .on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
      });
    });

    conn.on("error", reject);

    const connect: ConnectConfig = {
      host: config.host,
      port: config.port ?? 22,
      username: config.username,
    };
    if (config.privateKey?.trim()) {
      connect.privateKey = config.privateKey.trim();
    } else if (config.password?.trim()) {
      connect.password = config.password.trim();
    } else {
      reject(new Error("SSH password or private key is required"));
      return;
    }

    conn.connect(connect);
  });
}

export async function testDualPmsConnection(config: DualPmsSshConfig): Promise<void> {
  await execDualPmsPsql(config, "SELECT 1");
}
