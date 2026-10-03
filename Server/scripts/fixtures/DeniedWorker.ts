try { await fetch("https://fixture.invalid"); postMessage("未封闭"); }
catch (error) { postMessage(error instanceof Error ? error.message : "未知异常"); }
export {};
