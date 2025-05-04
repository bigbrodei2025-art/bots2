<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Painel do Bot WhatsApp</title>
</head>
<body>
  <h1>Enviar mensagem pelo Painel</h1>
  <form id="form">
    <label>Números (separados por vírgula):</label><br/>
    <input type="text" id="numeros" required><br/><br/>

    <label>Mensagem:</label><br/>
    <textarea id="mensagem" required></textarea><br/><br/>

    <label>Mídia (opcional):</label><br/>
    <input type="file" id="midia"><br/><br/>

    <button type="submit">Enviar</button>
  </form>

  <p id="status"></p>

  <script>
    document.getElementById("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const numeros = document.getElementById("numeros").value
        .split(",")
        .map(n => n.trim().replace(/\D/g, ""));
      const mensagem = document.getElementById("mensagem").value;
      const midiaInput = document.getElementById("midia");
      let midiaBase64 = null;
      let tipo = "text";

      if (midiaInput.files.length > 0) {
        const file = midiaInput.files[0];
        tipo = file.type.startsWith("image")
          ? "image"
          : file.type.startsWith("video")
          ? "video"
          : "document";

        const reader = new FileReader();
        reader.onload = async function () {
          midiaBase64 = reader.result.split(",")[1];

          await enviarDados();
        };
        reader.readAsDataURL(file);
      } else {
        await enviarDados();
      }

      async function enviarDados() {
        const res = await fetch("bot-production-cfcd.up.railway.app/enviar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numeros, mensagem, midiaBase64, tipo }),
        });

        const data = await res.json();
        document.getElementById("status").innerText = data.msg || "Erro";
      }
    });
  </script>
</body>
</html>
