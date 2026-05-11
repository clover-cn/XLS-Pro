const { defineConfig } = require('@vue/cli-service')
module.exports = defineConfig({
  transpileDependencies: true,
  chainWebpack: config => {
    config.plugin('fork-ts-checker').tap(args => {
      args[0].typescript.memoryLimit = 4096
      return args
    })
  },
  devServer: {
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true
      }
    }
  }
})
