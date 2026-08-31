import { defineConfig } from '@lingui/cli'
import { formatter } from '@lingui/format-po'

export default defineConfig({
  sourceLocale: 'zh-CN',
  locales: ['zh-CN', 'en'],
  catalogs: [
    {
      path: '<rootDir>/apps/web/src/i18n/locales/{locale}/messages',
      include: ['<rootDir>/apps/web/src'],
    },
  ],
  format: formatter({ lineNumbers: false }),
})
