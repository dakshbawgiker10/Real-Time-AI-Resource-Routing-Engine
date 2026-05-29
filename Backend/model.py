import torch
import torch.nn as nn

# Define the architecture of our 4-layer AI Brain
class PredictiveRoutingBrain(nn.Module):
    def __init__(self):
        super(PredictiveRoutingBrain, self).__init__()
        
        # Layer 1: Input (4 metrics) -> Hidden Layer 1 (16 neurons)
        self.input_layer = nn.Linear(in_features=4, out_features=16)
        
        # Activation Function: Bends the math lines so it can learn complex patterns
        self.relu1 = nn.ReLU()
        
        # Layer 2: Hidden 1 (16 neurons) -> Hidden Layer 2 (8 neurons)
        self.hidden_layer = nn.Linear(in_features=16, out_features=8)
        self.relu2 = nn.ReLU()
        
        # Layer 3 & 4: Hidden 2 (8 neurons) -> Output Layer (1 continuous number)
        self.output_layer = nn.Linear(in_features=8, out_features=1)

    def forward(self, x):
        """
        This is the execution path. Data flows forward through the layers.
        x represents our 4 input features: [connections, backlog, demand, time]
        """
        # Pass data through the first layer and bend it with ReLU
        out = self.input_layer(x)
        out = self.relu1(out)
        
        # Pass through the second layer and bend it again
        out = self.hidden_layer(out)
        out = self.relu2(out)
        
        # Final layer outputs the predicted processing delay millisecond value
        prediction = self.output_layer(out)
        return prediction