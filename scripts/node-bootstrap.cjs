const os = require("node:os");

try {
  os.userInfo();
} catch {
  os.userInfo = () => ({
    username: process.env.USERNAME || "integrationhub",
    uid: -1,
    gid: -1,
    shell: null,
    homedir: process.env.USERPROFILE || process.cwd()
  });
}
