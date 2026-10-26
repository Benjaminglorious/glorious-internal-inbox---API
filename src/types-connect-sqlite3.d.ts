declare module "connect-sqlite3" {
  import session from "express-session";
  function connectSqlite3(session: typeof import("express-session")): {
    new (options?: { db?: string; dir?: string; table?: string }): session.Store;
  };
  export = connectSqlite3;
}
