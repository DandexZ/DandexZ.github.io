<template>
  <div class="min-h-screen bg-white text-black font-sans">
    <header class="bg-black text-white p-4">
      <h1 class="text-3xl font-bold">我的个人网站</h1>
    </header>

    <main class="p-8">
      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-orange mb-4">关于我</h2>
        <p class="text-base">你好，我是一个前端开发者，热爱编程和设计。这个网站是我的个人展示平台。</p>
      </section>

      <section class="mb-12">
        <h2 class="text-2xl font-semibold text-orange mb-4">项目展示</h2>
        <ul class="space-y-4">
          <li class="border-l-4 border-orange pl-4">
            <h3 class="text-xl font-bold">项目一</h3>
            <p>这是一个使用Vue和Tailwind CSS构建的项目。</p>
          </li>
          <li class="border-l-4 border-orange pl-4">
            <h3 class="text-xl font-bold">项目二</h3>
            <p>这是一个使用Node.js和Express搭建的后端系统。</p>
          </li>
        </ul>
      </section>

      <section>
        <h2 class="text-2xl font-semibold text-orange mb-4">联系方式</h2>
        <p>邮箱：yourname@example.com</p>
        <p>GitHub：<a href="https://github.com/yourname" class="text-orange hover:underline">github.com/yourname</a></p>
      </section>
    </main>

    <footer class="bg-black text-white text-center p-4 mt-8">
      <p>&copy; 2025 我的名字. 保留所有权利。</p>
    </footer>
  </div>
</template>

<script setup>
</script>

<style scoped>
.text-orange {
  color: #ff8927;
}
.border-orange {
  border-color: #ff8927;
}
</style>
