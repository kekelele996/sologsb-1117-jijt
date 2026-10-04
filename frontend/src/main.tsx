import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AppRoutes } from '@/router'
import { seedDemoData, stampDbVersion } from '@/hooks/usePersistentStore'
import { hydrateAll } from '@/stores/hydrate'
import '@/styles/index.css'

/** 启动：写入示例数据（仅首次）→ 记录 schemaVersion → 从 IndexedDB 水合全部 store */
async function bootstrap(): Promise<void> {
  await seedDemoData()
  await stampDbVersion()
  await hydrateAll()
}

void bootstrap()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>
)
