// index.js - Bot de Arbitragem Completo (Executor)

// Importar a biblioteca ethers (versão 5, como instalado)
const ethers = require("ethers");

// --- CONFIGURAÇÃO ---
// Para o GitHub Actions, ele irá ler as variáveis de ambiente (process.env)
// Para testes locais, pode preencher os valores depois do "||"
const ALCHEMY_URL = process.env.ALCHEMY_URL || "SEU_URL_DO_ALCHEMY_AQUI";
const BOT_PRIVATE_KEY = process.env.BOT_PRIVATE_KEY || "SUA_CHAVE_PRIVADA_AQUI";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "SEU_ENDERECO_DE_CONTRATO_AQUI";

// Endereços importantes na rede Polygon
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDT_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

// Endereços dos routers das DEXs
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

// Quantidade de USDC para a arbitragem (e.g., 1,000 USDC)
const AMOUNT_TO_TRADE = ethers.utils.parseUnits("1000", 6); // USDC tem 6 casas decimais
// Lucro mínimo BRUTO para considerar a oportunidade (antes de calcular o gás)
const MINIMUM_PROFIT_THRESHOLD = ethers.utils.parseUnits("2.0", 6); // $2 de lucro bruto

// ABIs
const UNISWAP_V2_ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)"
];
const ARBITRAGE_CONTRACT_ABI = [
    // COLE AQUI A ABI COMPLETA DO SEU CONTRATO "Arbitrage.sol"
    // Exemplo mínimo necessário:
    "function executeFlashLoan(address _tokenToBorrow, uint256 _amount, address _router1, address _router2, address[] calldata _path1, address[] calldata _path2) external"
];
// --- FIM DA CONFIGURAÇÃO ---

// Validação para garantir que as variáveis de ambiente foram carregadas
if (!ALCHEMY_URL || !BOT_PRIVATE_KEY || !CONTRACT_ADDRESS) {
    console.error("Erro: As variáveis de ambiente (ALCHEMY_URL, BOT_PRIVATE_KEY, CONTRACT_ADDRESS) não estão definidas.");
    process.exit(1);
}

// Conectar à blockchain
const provider = new ethers.providers.JsonRpcProvider(ALCHEMY_URL);
// Criar uma carteira (signer) para poder assinar e enviar transações
const signer = new ethers.Wallet(BOT_PRIVATE_KEY, provider);
// Instanciar o nosso contrato de arbitragem para podermos chamá-lo
const arbitrageContract = new ethers.Contract(CONTRACT_ADDRESS, ARBITRAGE_CONTRACT_ABI, signer);

// Instanciar os contratos dos routers para consulta de preços
const quickswap = new ethers.Contract(QUICKSWAP_ROUTER, UNISWAP_V2_ROUTER_ABI, provider);
const sushiswap = new ethers.Contract(SUSHISWAP_ROUTER, UNISWAP_V2_ROUTER_ABI, provider);

// Função principal que orquestra a busca
async function main() {
    console.log("-----------------------------------------");
    console.log(`[${new Date().toLocaleTimeString('pt-PT')}] A iniciar verificação de arbitragem...`);
    
    // Define os caminhos de trade
    const pathUsdcToUsdt = [USDC_ADDRESS, USDT_ADDRESS];
    const pathUsdtToUsdc = [USDT_ADDRESS, USDC_ADDRESS];

    // --- Caminho 1: QuickSwap -> SushiSwap ---
    await checkAndExecute(
        { name: "QuickSwap", router: quickswap },
        { name: "SushiSwap", router: sushiswap },
        pathUsdcToUsdt,
        pathUsdtToUsdc
    );

    // --- Caminho 2: SushiSwap -> QuickSwap ---
    await checkAndExecute(
        { name: "SushiSwap", router: sushiswap },
        { name: "QuickSwap", router: quickswap },
        pathUsdcToUsdt,
        pathUsdtToUsdc
    );
}

// Função que verifica um caminho específico e executa se for lucrativo
async function checkAndExecute(dexA, dexB, path1, path2) {
    const pathName = `${dexA.name} -> ${dexB.name}`;
    try {
        // 1. Simular o primeiro swap
        const amountsOutA = await dexA.router.getAmountsOut(AMOUNT_TO_TRADE, path1);
        const receivedAmount = amountsOutA[1];

        // 2. Simular o segundo swap
        const amountsOutB = await dexB.router.getAmountsOut(receivedAmount, path2);
        const finalAmount = amountsOutB[1];

        // 3. Calcular o lucro bruto
        const profit = finalAmount.sub(AMOUNT_TO_TRADE);

        if (profit.gt(MINIMUM_PROFIT_THRESHOLD)) {
            console.log(`✅ OPORTUNIDADE ENCONTRADA (${pathName}) ✅`);
            console.log(`   - Lucro Bruto: ${ethers.utils.formatUnits(profit, 6)} USDC`);
            
            // 4. Estimar custos e executar a transação
            const gasPrice = await provider.getGasPrice();
            const gasEstimate = await arbitrageContract.estimateGas.executeFlashLoan(
                USDC_ADDRESS, AMOUNT_TO_TRADE, dexA.router.address, dexB.router.address, path1, path2
            );
            
            const gasCost = gasEstimate.mul(gasPrice);
            const flashLoanFee = AMOUNT_TO_TRADE.mul(9).div(10000); // 0.09%
            const netProfit = profit.sub(gasCost.add(flashLoanFee));

            console.log(`   - Custo de Gás Estimado: ${ethers.utils.formatUnits(gasCost, 18)} MATIC`);
            console.log(`   - Taxa Flash Loan: ${ethers.utils.formatUnits(flashLoanFee, 6)} USDC`);
            console.log(`   - Lucro Líquido Estimado: ${ethers.utils.formatUnits(netProfit, 6)} USDC`);

            if (netProfit.gt(0)) {
                console.log("   - Lucro líquido positivo. A ENVIAR TRANSAÇÃO...");
                const tx = await arbitrageContract.executeFlashLoan(
                    USDC_ADDRESS, AMOUNT_TO_TRADE, dexA.router.address, dexB.router.address, path1, path2,
                    { 
                        gasLimit: gasEstimate.add(ethers.utils.parseUnits('50', 'gwei')), // Margem de segurança
                        gasPrice: gasPrice 
                    }
                );

                const receipt = await tx.wait();
                console.log(`   - ✅ Transação executada com sucesso! Hash: ${receipt.transactionHash}`);
            } else {
                console.log("   - ❌ Lucro líquido negativo após custos. Transação não enviada.");
            }

        } else {
            // Esta mensagem é a mais comum. Não é um erro.
            // console.log(`   - ❌ Sem oportunidade (${pathName}).`);
        }
    } catch (error) {
         // Erros aqui podem ser normais (e.g., liquidez insuficiente para a simulação)
         // console.error(`   - ❗ Erro ao verificar o caminho ${pathName}:`, error.reason);
    }
}

// Inicia o bot
console.log("🤖 Bot de arbitragem iniciado. Pressione Ctrl+C para parar.");
// Executa uma vez no início e depois a cada 15 segundos
main();
setInterval(main, 15000); // 15000 milissegundos = 15 segundos