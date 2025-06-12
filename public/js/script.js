<script>
    // Seleciona o botão do menu hamburguer e o menu de navegação
    const hamburgerMenu = document.querySelector('.hamburger-menu');
    const mainNav = document.querySelector('.main-nav');

    // Adiciona um ouvinte de evento de clique ao botão hamburguer
    hamburgerMenu.addEventListener('click', () => {
        // Alterna a classe 'active' no menu de navegação
        // Isso fará com que o menu se expanda ou contraia (definido no CSS)
        mainNav.classList.toggle('active');
    });

    // Opcional: Fechar o menu quando um link é clicado (útil para navegação em uma única página)
    mainNav.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            if (mainNav.classList.contains('active')) {
                mainNav.classList.remove('active');
            }
        });
    });

    // Marca o link da página atual como ativo
    document.addEventListener('DOMContentLoaded', () => {
        const currentPath = window.location.pathname.split('/').pop(); // Pega o nome do arquivo, ex: index.html
        const navLinks = mainNav.querySelectorAll('a');

        navLinks.forEach(link => {
            const linkPath = link.getAttribute('href').split('/').pop();
            // Verifica se o caminho do link é vazio (para index.html em alguns servidores)
            // ou se corresponde ao caminho atual
            if (currentPath === linkPath || (currentPath === '' && linkPath === 'index.html')) {
                link.classList.add('active'); // Adiciona a classe 'active'
            }
        });
    });

</script>
